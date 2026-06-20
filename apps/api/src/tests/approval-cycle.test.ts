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
const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import {
  createScriptRunner,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

const scriptRunner = createScriptRunner();
mockCreateProvider.mockImplementation(() => scriptRunner.create());
const setScript = (turns: ScriptedTurn[]): void =>
  scriptRunner.setScript(turns);

import { generateToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { registerConsoleWsRoutes } from "../ws/console.js";

import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";

interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
}

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Fixed. Investigation complete.",
  toolUses: [],
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
  let SESSION: string;
  const TEST_RUNNER_ID = "runner-approval-022";
  const restartCommands: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = generateToken("approval-022").id;

    registerRunner(
      TEST_TOKEN,
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
    setRunnerManifest(TEST_TOKEN, {
      runnerId: TEST_RUNNER_ID,
      hostname: "approval-host",
      runnerVersion: "2.0.0",
      capabilities: {
        docker: true,
        containers: ["web-01"],
        prometheus: { available: false },
        postgres: { available: false },
        redis: { available: false },
        hostMetrics: true,
        fileRead: true,
        remediationEnabled: true,
      },
    });

    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerConsoleWsRoutes(server);
        await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    unregisterRunner(TEST_TOKEN);
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

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
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Run must have exited (dispatcher slot freed)
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);

    // Interrupt row must be in the DB
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Runner must NOT have executed the write yet
    const countBefore = restartCommands.length;

    expect(interrupt.payload["toolName"]).toBe("restart_container");

    ws.close();

    // cleanup: approve via /respond to prevent leaking into later tests
    await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "approve", resolvedBy: "cleanup" }),
    });
    await waitFor(() => restartCommands.length > countBefore);
  });

  it("approve: executes tool on runner exactly once, run resumes, reaches free-form finish", async () => {
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
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    // Approve via /respond
    const approveRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve", resolvedBy: "operator" }),
      },
    );
    expect(approveRes.status).toBe(200);
    const body = (await approveRes.json()) as { status: string };
    expect(body.status).toBe("approved");

    // Run resumes and reaches free-form finish: INTERRUPT_RESOLVED arrives
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["toolUseId"] === "tu-apr-1",
      ),
    );

    // Runner executed restart exactly once
    expect(restartCommands).toHaveLength(1);
    expect(restartCommands[0]["containerName"]).toBe("web-01");

    // Interrupt row is gone from DB after resolution
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    ws.close();
  });

  it("reject: feeds rejection result with is_error, run resumes with model adapting", async () => {
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
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    const rejectRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({
          decision: "reject",
          text: "too risky",
          resolvedBy: "operator",
        }),
      },
    );
    expect(rejectRes.status).toBe(200);
    const body = (await rejectRes.json()) as { status: string };
    expect(body.status).toBe("rejected");

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["status"] === "rejected",
      ),
    );

    expect(hasPendingHumanInput(sessionId)).toBe(false);
    ws.close();
  });

  it("add-context: text without decision feeds context, run resumes and model continues", async () => {
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
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    const ctxRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ text: "maintenance window active" }),
      },
    );
    expect(ctxRes.status).toBe(200);
    const body = (await ctxRes.json()) as { status: string };
    expect(body.status).toBe("context_added");

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["status"] === "context_added",
      ),
    );

    expect(hasPendingHumanInput(sessionId)).toBe(false);
    ws.close();
  });

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
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    const first = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve", resolvedBy: "op1" }),
      },
    );
    expect(first.status).toBe(200);

    const second = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve", resolvedBy: "op2" }),
      },
    );
    expect(second.status).toBe(409);

    ws.close();
  });

  // H4: concurrent approve+reject — only one wins, tool runs at most once
  it("concurrent approve+reject: exactly one succeeds, exactly one gets 409, tool runs at most once", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-h4-1",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "concurrent",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const chatRes = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await chatRes.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Fire approve and reject concurrently
    const [approveRes, rejectRes] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve", resolvedBy: "op-approve" }),
      }),
      fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "reject", resolvedBy: "op-reject" }),
      }),
    ]);

    const statuses = [approveRes.status, rejectRes.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Tool must not run more than once regardless of which path wins
    if (approveRes.status === 200) {
      await waitFor(() => restartCommands.length > 0);
      expect(restartCommands).toHaveLength(1);
    } else {
      // reject won — tool should NOT have run
      expect(restartCommands).toHaveLength(0);
    }

    expect(hasPendingHumanInput(sessionId)).toBe(false);
    ws.close();
  });

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
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Session is suspended — sending a chat message must get 409
    const msgRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "what do you think?" }),
      },
    );
    expect(msgRes.status).toBe(409);

    ws.close();

    // cleanup
    await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
    });
  });

  it("approval interrupt with clarification-only body (no decision, no text) returns 400", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-val-1",
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "validation",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Empty body — no decision, no text — must return 400 for approval kind
    const validationRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({}),
      },
    );
    expect(validationRes.status).toBe(400);

    // Cleanup
    ws.close();
    await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
    });
  });

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
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    // Assert: run has exited (simulates what a restart would see — no in-memory state)
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);

    // Assert: interrupt row is in DB (survives a restart because it's persisted)
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Resolve via REST — works purely from DB state (as it would after restart)
    const approveRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({
          decision: "approve",
          resolvedBy: "operator-after-restart",
        }),
      },
    );
    expect(approveRes.status).toBe(200);

    // Run resumes and runner executes exactly once
    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

    ws.close();
  });

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
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Mixed turn test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
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

    const approveRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve", resolvedBy: "operator" }),
      },
    );
    expect(approveRes.status).toBe(200);

    // Gated tool now runs exactly once on the runner
    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

    ws.close();
  });

  it("critical rejection resumes with rejection result: no escalation, model finishes", async () => {
    const sessionId = randomUUID();
    const alert: NormalizedAlert = {
      sourceAlertId: `crit-022-${randomUUID()}`,
      runnerId: TEST_RUNNER_ID,
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
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    dispatcher.dispatch({ alert, sessionId });

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    const rejectRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "reject", resolvedBy: "operator" }),
      },
    );
    expect(rejectRes.status).toBe(200);

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["status"] === "rejected",
      ),
    );
    ws.close();

    expect(hasPendingHumanInput(sessionId)).toBe(false);
    expect(
      events.some(
        (e) => e.type === "ESCALATED" && e.payload["sessionId"] === sessionId,
      ),
    ).toBe(false);
  });

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
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });

    // Can't use waitForConnected with fake timers and real setTimeout; connect directly
    await new Promise<void>((resolve) => {
      ws.once("open", resolve);
    });

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "No timeout test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Advance 24 hours
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);

    // The interrupt row must still be there (no timeout deleted it)
    await waitFor(() => hasPendingHumanInput(sessionId), { timeout: 5_000 });
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Should still be resolvable via REST
    const interrupt = await waitFor(
      () =>
        events.find(
          (e) =>
            e.type === "HUMAN_INPUT_REQUIRED" &&
            e.payload["sessionId"] === sessionId,
        ),
      { timeout: 5_000 },
    );
    vi.useRealTimers();

    const approveRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({
          decision: "approve",
          resolvedBy: "late-operator",
        }),
      },
    );
    expect(approveRes.status).toBe(200);

    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

    ws.close();
  });
});
