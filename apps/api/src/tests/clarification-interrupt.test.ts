import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { RunnerCommandMessage } from "@nightwatch/shared";

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
import { mintTestSession } from "./session-helper.js";
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

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Answered. Investigation complete.",
  toolUses: [],
};

const TEST_OPTIONS = [
  {
    label: "Database overloaded",
    description: "High query volume saturated connection pool",
  },
  { label: "Memory leak", description: "Gradual memory growth causing OOM" },
];

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

describe("clarification interrupts", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let TEST_TOKEN: string;
  let SESSION: string;
  const TEST_RUNNER_ID = "runner-clarification-023";
  const restartCommands: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = mintTestSession();
    TEST_TOKEN = mintToken("clarification-023").id;

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

  it("request_clarification suspends: interrupt row kind=clarification, INTERRUPT event has kind+question+options, run exited", async () => {
    setScript([
      {
        text: "Need clarification.",
        toolUses: [
          {
            id: "tu-clar-1",
            name: "request_clarification",
            input: {
              question: "What is the likely root cause?",
              options: TEST_OPTIONS,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_session=${SESSION}` },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `nw_session=${SESSION}` },
      body: JSON.stringify({ message: "Service degraded." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );

    // Run must have exited
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);

    // DB row must have kind=clarification
    expect(hasPendingInterrupt(sessionId)).toBe(true);

    // INTERRUPT event carries kind + question + options
    expect(interrupt.payload["kind"]).toBe("clarification");
    expect(interrupt.payload["question"]).toBe(
      "What is the likely root cause?",
    );
    expect(interrupt.payload["options"]).toEqual(TEST_OPTIONS);
    expect(interrupt.payload["toolName"]).toBe("request_clarification");

    ws.close();

    // cleanup
    const incidentId = String(interrupt.payload["incidentId"]);
    await fetch(`http://127.0.0.1:${port}/incidents/${incidentId}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `nw_session=${SESSION}` },
      body: JSON.stringify({ answer: "cleanup" }),
    });
    await waitFor(() => !hasPendingInterrupt(sessionId));
  });

  it("answer resolves: resumes run, tool result contains answer, reaches free-form finish", async () => {
    setScript([
      {
        text: "Need clarification.",
        toolUses: [
          {
            id: "tu-ans-1",
            name: "request_clarification",
            input: {
              question: "Which container is affected?",
              options: TEST_OPTIONS,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_session=${SESSION}` },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `nw_session=${SESSION}` },
      body: JSON.stringify({ message: "Which container?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );
    const incidentId = String(interrupt.payload["incidentId"]);

    const answerRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `nw_session=${SESSION}` },
        body: JSON.stringify({
          answer: "Database overloaded",
          resolvedBy: "operator",
        }),
      },
    );
    expect(answerRes.status).toBe(200);
    const body = (await answerRes.json()) as { status: string };
    expect(body.status).toBe("answered");

    // INTERRUPT_RESOLVED arrives, run resumes, reaches free-form finish
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "INTERRUPT_RESOLVED" &&
          e.payload["toolUseId"] === "tu-ans-1",
      ),
    );

    // Interrupt row gone after resolution
    expect(hasPendingInterrupt(sessionId)).toBe(false);

    ws.close();
  });

  it("multiSelect answer: joins selections as comma-separated string in tool result", async () => {
    setScript([
      {
        text: "Which factors apply?",
        toolUses: [
          {
            id: "tu-ms-1",
            name: "request_clarification",
            input: {
              question: "Which factors apply?",
              options: TEST_OPTIONS,
              multiSelect: true,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_session=${SESSION}` },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `nw_session=${SESSION}` },
      body: JSON.stringify({ message: "Factors?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );
    expect(interrupt.payload["multiSelect"]).toBe(true);

    const incidentId = String(interrupt.payload["incidentId"]);
    const answerRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `nw_session=${SESSION}` },
        body: JSON.stringify({
          answer: ["Database overloaded", "Memory leak"],
          resolvedBy: "operator",
        }),
      },
    );
    expect(answerRes.status).toBe(200);

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "INTERRUPT_RESOLVED" &&
          e.payload["toolUseId"] === "tu-ms-1",
      ),
    );
    expect(hasPendingInterrupt(sessionId)).toBe(false);

    ws.close();
  });

  it("restart-resume: clarification interrupt survives process exit, resolve still works", async () => {
    setScript([
      {
        text: "Clarifying.",
        toolUses: [
          {
            id: "tu-rr-clar-1",
            name: "request_clarification",
            input: { question: "Is this recurring?", options: TEST_OPTIONS },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_session=${SESSION}` },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `nw_session=${SESSION}` },
      body: JSON.stringify({ message: "Is this recurring?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) => e.type === "INTERRUPT" && e.payload["sessionId"] === sessionId,
      ),
    );
    const incidentId = String(interrupt.payload["incidentId"]);

    // Simulate process exit: run has exited, no in-memory state needed
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);
    expect(hasPendingInterrupt(sessionId)).toBe(true);

    // Resolve purely from DB state
    const answerRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `nw_session=${SESSION}` },
        body: JSON.stringify({
          answer: "Yes, recurring daily",
          resolvedBy: "operator-after-restart",
        }),
      },
    );
    expect(answerRes.status).toBe(200);

    await waitFor(() => !hasPendingInterrupt(sessionId));
    expect(hasPendingInterrupt(sessionId)).toBe(false);

    ws.close();
  });

  it("mixed two-gate turn: clarification suspends first, then approval suspends on resume, run completes", async () => {
    restartCommands.length = 0;
    const clarId = `tu-mix-clar-${randomUUID()}`;
    const restart1Id = `tu-mix-restart1-${randomUUID()}`;
    const restart2Id = `tu-mix-restart2-${randomUUID()}`;

    setScript([
      {
        text: "Ask then restart.",
        toolUses: [
          {
            id: clarId,
            name: "request_clarification",
            input: {
              question: "Confirm restart?",
              options: [{ label: "Yes", description: "Proceed" }],
            },
          },
          {
            id: restart1Id,
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
      {
        text: "Now restarting.",
        toolUses: [
          {
            id: restart2Id,
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "confirmed",
              risk: "low",
              estimatedDowntimeSeconds: 2,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_session=${SESSION}` },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `nw_session=${SESSION}` },
      body: JSON.stringify({ message: "Mixed gate test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // First interrupt: clarification
    const clarInterrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "INTERRUPT" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "clarification",
      ),
    );
    expect(clarInterrupt.payload["kind"]).toBe("clarification");
    expect(restartCommands).toHaveLength(0);

    const clarIncidentId = String(clarInterrupt.payload["incidentId"]);
    const answerRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${clarIncidentId}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `nw_session=${SESSION}` },
        body: JSON.stringify({ answer: "Yes", resolvedBy: "operator" }),
      },
    );
    expect(answerRes.status).toBe(200);

    // Second interrupt: approval for restart
    const approvalInterrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "INTERRUPT" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "approval",
      ),
    );
    expect(approvalInterrupt.payload["toolName"]).toBe("restart_container");
    expect(restartCommands).toHaveLength(0);

    const approvalIncidentId = String(approvalInterrupt.payload["incidentId"]);
    const approveRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${approvalIncidentId}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `nw_session=${SESSION}` },
        body: JSON.stringify({ resolvedBy: "operator" }),
      },
    );
    expect(approveRes.status).toBe(200);

    // Restart executes exactly once, run completes
    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);
    expect(hasPendingInterrupt(sessionId)).toBe(false);

    ws.close();
  });
});
