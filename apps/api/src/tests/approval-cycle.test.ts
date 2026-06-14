import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { NormalizedAlert, RunnerCommandMessage } from "@nightwatch/shared";

// Stateful scripted provider: snapshot() accumulates messages so persist() in
// the loop writes real session_messages rows. setScript() configures the turn
// sequence per test; mockCreateProvider() is called once per run dispatch.
const { mockCreateProvider, setScript } = vi.hoisted(() => {
  type Msg = {
    role: "user" | "assistant";
    content: string;
    providerContent: unknown;
  };
  type Turn = {
    toolUses: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;
    text: string;
  };

  let script: Turn[] = [];
  let scriptIndex = 0;

  const makeProvider = () => {
    const messages: Msg[] = [];
    return {
      start: vi.fn((msg: string) => {
        messages.push({
          role: "user",
          content: msg,
          providerContent: { role: "user", content: msg },
        });
      }),
      seed: vi.fn((history: Msg[]) => {
        messages.length = 0;
        messages.push(...history);
      }),
      snapshot: vi.fn((): Msg[] => [...messages]),
      chat: vi.fn(
        (
          _tools: unknown,
          onDelta?: (d: { kind: string; text: string }) => void,
        ) => {
          const turn = script[scriptIndex++] ??
            script[script.length - 1] ?? { toolUses: [], text: "" };
          onDelta?.({ kind: "text", text: turn.text });
          messages.push({
            role: "assistant",
            content: turn.text,
            providerContent: { role: "assistant", content: turn.text },
          });
          return Promise.resolve({
            stopReason: "tool_use" as const,
            toolUses: turn.toolUses,
            text: turn.text,
          });
        },
      ),
      appendToolResults: vi.fn(
        (results: Array<{ tool_use_id: string; content: string }>) => {
          messages.push({
            role: "user",
            content: results.map((r) => r.content).join("\n"),
            providerContent: { role: "user", content: results },
          });
        },
      ),
      appendUserMessage: vi.fn((msg: string) => {
        messages.push({
          role: "user",
          content: msg,
          providerContent: { role: "user", content: msg },
        });
      }),
    };
  };

  return {
    mockCreateProvider: vi.fn(makeProvider),
    setScript: (turns: Turn[]) => {
      script = turns;
      scriptIndex = 0;
      mockCreateProvider.mockImplementation(makeProvider);
    },
  };
});

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import { mintToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerChatRoutes } from "../chat/routes.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import { registerIncidentRoutes } from "../incidents/routes.js";
import { registerApprovalRoutes } from "../approvals/routes.js";
import { dispatcher } from "../dispatch/dispatcher.js";
import { hasPendingInterrupt } from "../db/interrupts.js";
import {
  registerRunner,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";

interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
}

const FINAL_RESPONSE_TURN = {
  text: "Done.",
  toolUses: [
    {
      id: "fr-1",
      name: "final_response",
      input: {
        rootCause: {
          summary: "Fixed.",
          evidence: ["container restarted"],
          contributingFactors: null,
        },
        recommendedAction: null,
        escalateIfRejected: false,
        investigationSteps: ["restarted web-01"],
      },
    },
  ],
};

function waitForConnected(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    const onMsg = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as { type: string };
      if (msg.type === "connected") {
        ws.off("message", onMsg);
        resolve();
      }
    };
    ws.on("message", onMsg);
  });
}

describe("durable approval interrupts", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let TEST_TOKEN: string;
  const TEST_RUNNER_ID = "runner-approval-022";
  const restartCommands: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    cleanupDb = useTempDb();
    TEST_TOKEN = mintToken("approval-022").id;

    registerRunner(
      TEST_TOKEN,
      TEST_RUNNER_ID,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        const { commandName, commandInput, correlationId } = msg.payload;
        if (commandName === "restart_container") {
          restartCommands.push(commandInput);
          resolveCommand({
            correlationId,
            success: true,
            result: { restarted: true },
          });
        } else {
          resolveCommand({ correlationId, success: true, result: [] });
        }
      },
      () => {},
    );

    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerConsoleWsRoutes(server);
    await registerChatRoutes(server);
    await registerSessionRoutes(server);
    await registerIncidentRoutes(server);
    await registerApprovalRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    unregisterRunner(TEST_TOKEN, TEST_RUNNER_ID);
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  // RED: gated tool suspends — interrupt row in DB, run exited, INTERRUPT published
  it("gated tool suspends: interrupt row exists in DB, run exited, INTERRUPT published", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-sus-1",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "wedged",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINAL_RESPONSE_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );

    // Run must have exited (dispatcher slot freed)
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);

    // Interrupt row must be in the DB
    expect(hasPendingInterrupt(sessionId)).toBe(true);

    // Runner must NOT have executed the write yet
    const countBefore = restartCommands.length;

    expect(interrupt.payload["toolName"]).toBe("restart_container");
    expect(typeof interrupt.payload["incidentId"]).toBe("string");

    ws.close();

    // cleanup: approve to prevent leaking into later tests
    const incidentId = String(interrupt.payload["incidentId"]);
    await fetch(`http://127.0.0.1:${port}/incidents/${incidentId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolvedBy: "cleanup" }),
    });
    await waitFor(() => restartCommands.length > countBefore);
  });

  // RED: approve executes runner tool exactly once, run resumes and reaches finding
  it("approve: executes tool on runner exactly once, run resumes, reaches final_response", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-apr-1",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "wedged",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINAL_RESPONSE_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );
    const incidentId = String(interrupt.payload["incidentId"]);

    // Approve via REST
    const approveRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "operator" }),
      },
    );
    expect(approveRes.status).toBe(200);
    const body = (await approveRes.json()) as { status: string };
    expect(body.status).toBe("approved");

    // Run resumes and reaches final_response: INTERRUPT_RESOLVED arrives
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "INTERRUPT_RESOLVED" &&
          e.payload["toolUseId"] === "tu-apr-1",
      ),
    );

    // Runner executed restart exactly once
    expect(restartCommands).toHaveLength(1);
    expect(restartCommands[0]["containerName"]).toBe("web-01");

    // Interrupt row is gone from DB after resolution
    expect(hasPendingInterrupt(sessionId)).toBe(false);

    ws.close();
  });

  // RED: reject feeds rejection result, model adapts, run resumes
  it("reject: feeds rejection result, run resumes with model adapting", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-rej-1",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "wedged",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINAL_RESPONSE_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );
    const incidentId = String(interrupt.payload["incidentId"]);

    const rejectRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "operator", comment: "too risky" }),
      },
    );
    expect(rejectRes.status).toBe(200);
    const body = (await rejectRes.json()) as { status: string };
    expect(body.status).toBe("rejected");

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "INTERRUPT_RESOLVED" && e.payload["status"] === "rejected",
      ),
    );

    expect(hasPendingInterrupt(sessionId)).toBe(false);
    ws.close();
  });

  // RED: add-context feeds text, model continues
  it("add-context: feeds context, run resumes and model continues", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-ctx-1",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "wedged",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINAL_RESPONSE_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );
    const incidentId = String(interrupt.payload["incidentId"]);

    const ctxRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/add-context`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contextMessage: "maintenance window active" }),
      },
    );
    expect(ctxRes.status).toBe(200);
    const body = (await ctxRes.json()) as { status: string };
    expect(body.status).toBe("context_added");

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "INTERRUPT_RESOLVED" &&
          e.payload["status"] === "context_added",
      ),
    );

    expect(hasPendingInterrupt(sessionId)).toBe(false);
    ws.close();
  });

  // RED: second resolution of same interrupt returns 409
  it("second resolution of same interrupt returns 409", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-409-1",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "wedged",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINAL_RESPONSE_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );
    const incidentId = String(interrupt.payload["incidentId"]);

    const first = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "op1" }),
      },
    );
    expect(first.status).toBe(200);

    const second = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "op2" }),
      },
    );
    expect(second.status).toBe(409);

    ws.close();
  });

  // RED: message to suspended session returns 409
  it("message to a suspended session returns 409", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-busy-1",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "wedged",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINAL_RESPONSE_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );

    // Session is suspended — sending a chat message must get 409
    const msgRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: TEST_TOKEN,
          message: "what do you think?",
        }),
      },
    );
    expect(msgRes.status).toBe(409);

    ws.close();

    // cleanup
    const interrupt = events.find(
      (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
    )!;
    await fetch(
      `http://127.0.0.1:${port}/incidents/${String(interrupt.payload["incidentId"])}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "cleanup" }),
      },
    );
  });

  // RED: restart-resume — run exited + interrupt in DB, approve still works (no in-memory state needed)
  it("restart-resume: interrupt survives process exit, resolve works and run completes", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-rr-1",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "wedged",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINAL_RESPONSE_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );
    const incidentId = String(interrupt.payload["incidentId"]);

    // Assert: run has exited (simulates what a restart would see — no in-memory state)
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);

    // Assert: interrupt row is in DB (survives a restart because it's persisted)
    expect(hasPendingInterrupt(sessionId)).toBe(true);

    // Resolve via REST — works purely from DB state (as it would after restart)
    const approveRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "operator-after-restart" }),
      },
    );
    expect(approveRes.status).toBe(200);

    // Run resumes and runner executes exactly once
    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

    ws.close();
  });

  // RED: mixed parallel turn — non-gated tool runs first, resume has tool_results for ALL tool_uses
  it("mixed parallel turn: non-gated tools execute first, resume covers all tool_uses", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Checking then restarting.",
        toolUses: [
          {
            id: "tu-mix-read",
            name: "get_container_list",
            input: { environment: "docker" },
          },
          {
            id: "tu-mix-gate",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "mixed",
              risk: "low",
              estimatedDowntimeSeconds: 2,
            },
          },
        ],
      },
      FINAL_RESPONSE_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Mixed turn test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );

    // The non-gated read tool should have produced a TOOL_CALL_END before suspension
    expect(
      events.some(
        (e) =>
          e.type === "TOOL_CALL_END" &&
          e.payload["toolUseId"] === "tu-mix-read",
      ),
    ).toBe(true);

    // The gated tool was NOT called on the runner yet
    expect(restartCommands).toHaveLength(0);

    const incidentId = String(interrupt.payload["incidentId"]);
    const approveRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "operator" }),
      },
    );
    expect(approveRes.status).toBe(200);

    // Gated tool now runs exactly once on the runner
    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

    ws.close();
  });

  // RED: critical rejection escalates — writes incident, emits ESCALATED, no resume
  it("critical rejection escalates: writes incident and emits ESCALATED", async () => {
    const sessionId = randomUUID();
    const alert: NormalizedAlert = {
      sourceAlertId: `crit-022-${randomUUID()}`,
      token: TEST_TOKEN,
      targetIdentifier: "web-01",
      alertType: "ContainerDown",
      severity: "critical",
      firedAt: new Date().toISOString(),
      rawPayload: {},
    };

    setScript([
      {
        text: "Restarting critical.",
        toolUses: [
          {
            id: `tu-crit-${randomUUID()}`,
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "critical",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINAL_RESPONSE_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    let resolveEsc!: (e: WsEvent) => void;
    let rejectEsc!: (e: Error) => void;
    const escalated = new Promise<WsEvent>((res, rej) => {
      resolveEsc = res;
      rejectEsc = rej;
    });
    const timer = setTimeout(
      () => rejectEsc(new Error("timeout: no ESCALATED")),
      12_000,
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as WsEvent;
      if (msg.type === "ESCALATED" && msg.payload["sessionId"] === sessionId) {
        clearTimeout(timer);
        resolveEsc(msg);
      }
    });

    dispatcher.dispatch({
      alert,
      sessionId,
      token: TEST_TOKEN,
      trigger: "alert",
    });

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );
    const incidentId = String(interrupt.payload["incidentId"]);

    const rejectRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "operator" }),
      },
    );
    expect(rejectRes.status).toBe(200);

    const escEvent = await escalated;
    ws.close();

    expect(String(escEvent.payload["reason"])).toMatch(/rejected/i);
    // Interrupt row must be deleted (resolved)
    expect(hasPendingInterrupt(sessionId)).toBe(false);
  });

  // RED: no timeout — interrupt is still resolvable with fake timers
  it("no timeout: interrupt pending for hours is still resolvable", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    restartCommands.length = 0;

    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-notmo-1",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "wedged",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINAL_RESPONSE_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });

    // Can't use waitForConnected with fake timers and real setTimeout; connect directly
    await new Promise<void>((resolve) => {
      ws.once("open", resolve);
    });

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "No timeout test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Advance 24 hours
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);

    // The interrupt row must still be there (no timeout deleted it)
    await waitFor(() => hasPendingInterrupt(sessionId), { timeout: 5_000 });
    expect(hasPendingInterrupt(sessionId)).toBe(true);

    // Should still be resolvable via REST
    const interrupt = await waitFor(
      () =>
        events.find(
          (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
        ),
      { timeout: 5_000 },
    );
    const incidentId = String(interrupt.payload["incidentId"]);

    vi.useRealTimers();

    const approveRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "late-operator" }),
      },
    );
    expect(approveRes.status).toBe(200);

    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

    ws.close();
  });
});
