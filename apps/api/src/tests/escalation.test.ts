import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { Worker } from "bullmq";
import type { RunnerCommandMessage } from "@nightwatch/shared";

const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import { db } from "../db/client.js";
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerChatRoutes } from "../chat/routes.js";
import { registerIncidentRoutes } from "../incidents/routes.js";
import { enqueueJob } from "../alerts/queue.js";
import { startWorker } from "../jobs/worker.js";
import type { NormalizedAlert } from "@nightwatch/shared";
import {
  registerRunner,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";

interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
}

function makeRefusalProvider() {
  return {
    start: vi.fn(),
    seed: vi.fn(),
    snapshot: vi.fn(() => [
      { role: "user", content: "test", providerContent: {} },
    ]),
    chat: vi.fn(() =>
      Promise.resolve({
        stopReason: "refusal" as const,
        toolUses: [],
        text: "I cannot help with that.",
      }),
    ),
    appendToolResults: vi.fn(),
    appendUserMessage: vi.fn(),
  };
}

function makeStopProvider() {
  return {
    start: vi.fn(),
    seed: vi.fn(),
    snapshot: vi.fn(() => [
      { role: "user", content: "test", providerContent: {} },
    ]),
    chat: vi.fn(() =>
      Promise.resolve({
        stopReason: "stop" as const,
        toolUses: [],
        text: "I am done.",
      }),
    ),
    appendToolResults: vi.fn(),
    appendUserMessage: vi.fn(),
  };
}

// Proposes a gated write on its first (and only) turn. With a critical alert,
// a human rejection must escalate before any second turn.
function makeCriticalWriteProvider() {
  return {
    start: vi.fn(),
    seed: vi.fn(),
    snapshot: vi.fn(() => [
      { role: "user", content: "test", providerContent: {} },
    ]),
    chat: vi.fn(() =>
      Promise.resolve({
        stopReason: "tool_use" as const,
        toolUses: [
          {
            id: `tu-${randomUUID()}`,
            name: "restart_container",
            input: { containerName: "web-01" },
          },
        ],
        text: "",
      }),
    ),
    appendToolResults: vi.fn(),
    appendUserMessage: vi.fn(),
  };
}

// Calls a read tool every turn and never concludes, so the loop exhausts
// maxToolCalls and escalates on the budget exit.
function makeToolLoopProvider() {
  return {
    start: vi.fn(),
    seed: vi.fn(),
    snapshot: vi.fn(() => [
      { role: "user", content: "test", providerContent: {} },
    ]),
    chat: vi.fn(() =>
      Promise.resolve({
        stopReason: "tool_use" as const,
        toolUses: [
          {
            id: `tu-${randomUUID()}`,
            name: "get_container_list",
            input: { environment: "docker" },
          },
        ],
        text: "",
      }),
    ),
    appendToolResults: vi.fn(),
    appendUserMessage: vi.fn(),
  };
}

describe("escalation paths write an incident and emit ESCALATED", () => {
  let server: FastifyInstance;
  let worker: Worker;
  let port: number;
  let userId: string;
  const TEST_TOKEN = `test-esc-${randomUUID()}`;
  const TEST_RUNNER_ID = "test-runner-esc";
  const writeIncidentCalls: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    const user = await db.user.create({
      data: { email: `test-esc-${randomUUID()}@nightwatch-test.local` },
    });
    userId = user.id;
    await db.token.create({
      data: { token: TEST_TOKEN, userId, hostname: "test-esc-runner" },
    });

    registerRunner(TEST_TOKEN, TEST_RUNNER_ID, (raw: string) => {
      const msg = JSON.parse(raw) as RunnerCommandMessage;
      const { commandName, commandInput, correlationId } = msg.payload;
      if (commandName === "write_incident") {
        writeIncidentCalls.push(commandInput as Record<string, unknown>);
        resolveCommand({ correlationId, success: true, result: { ok: true } });
      } else if (commandName === "append_session_message") {
        resolveCommand({ correlationId, success: true, result: { ok: true } });
      } else {
        resolveCommand({ correlationId, success: true, result: [] });
      }
    });

    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerConsoleWsRoutes(server);
    await registerChatRoutes(server);
    await registerIncidentRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;

    worker = startWorker();
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    unregisterRunner(TEST_TOKEN, TEST_RUNNER_ID);
    await server.close();
    await db.token.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  });

  it("model refusal escalates: writes incident and emits ESCALATED", async () => {
    writeIncidentCalls.length = 0;
    mockCreateProvider.mockImplementationOnce(makeRefusalProvider);

    // Open the console WS before dispatching so we don't miss the ESCALATED
    // event that fires synchronously after the investigation ends.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    await new Promise<void>((res) => ws.on("open", res));

    let targetSessionId: string | undefined;
    let resolveEscalated!: (e: WsEvent) => void;
    let rejectEscalated!: (err: Error) => void;
    const escalatedArrived = new Promise<WsEvent>((res, rej) => {
      resolveEscalated = res;
      rejectEscalated = rej;
    });

    const timer = setTimeout(
      () => rejectEscalated(new Error("timeout: no ESCALATED event")),
      10_000,
    );

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as WsEvent;
      if (
        msg.type === "ESCALATED" &&
        (!targetSessionId || msg.payload["sessionId"] === targetSessionId)
      ) {
        clearTimeout(timer);
        resolveEscalated(msg);
      }
    });

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Do something dangerous." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    targetSessionId = sessionId;

    const event = await escalatedArrived;
    ws.close();

    expect(event.payload["sessionId"]).toBe(sessionId);
    expect(event.payload["incidentId"]).toBeTruthy();
    expect(String(event.payload["reason"])).toMatch(/refus/i);

    expect(writeIncidentCalls.length).toBeGreaterThanOrEqual(1);
    const record = writeIncidentCalls[writeIncidentCalls.length - 1];
    expect(record["rootCause"]).toBeTruthy();
    expect(record["alertType"]).toBe("chat");
    expect(record["outcome"]).toBe("escalated");
  });

  it("stop without final_response escalates: writes incident and emits ESCALATED", async () => {
    writeIncidentCalls.length = 0;
    mockCreateProvider.mockImplementationOnce(makeStopProvider);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    await new Promise<void>((res) => ws.on("open", res));

    let targetSessionId: string | undefined;
    let resolveEscalated!: (e: WsEvent) => void;
    let rejectEscalated!: (err: Error) => void;
    const escalatedArrived = new Promise<WsEvent>((res, rej) => {
      resolveEscalated = res;
      rejectEscalated = rej;
    });

    const timer = setTimeout(
      () => rejectEscalated(new Error("timeout: no ESCALATED event")),
      10_000,
    );

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as WsEvent;
      if (
        msg.type === "ESCALATED" &&
        (!targetSessionId || msg.payload["sessionId"] === targetSessionId)
      ) {
        clearTimeout(timer);
        resolveEscalated(msg);
      }
    });

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Wrap up." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    targetSessionId = sessionId;

    const event = await escalatedArrived;
    ws.close();

    expect(event.payload["sessionId"]).toBe(sessionId);
    expect(writeIncidentCalls.length).toBeGreaterThanOrEqual(1);
    expect(writeIncidentCalls[writeIncidentCalls.length - 1]?.["outcome"]).toBe(
      "escalated",
    );
  });

  it("rejected critical write escalates: writes incident and emits ESCALATED", async () => {
    writeIncidentCalls.length = 0;
    mockCreateProvider.mockImplementationOnce(makeCriticalWriteProvider);

    const sessionId = randomUUID();
    const alert: NormalizedAlert = {
      sourceAlertId: `crit-${randomUUID()}`,
      token: TEST_TOKEN,
      targetIdentifier: "web-01",
      alertType: "ContainerDown",
      severity: "critical",
      firedAt: new Date().toISOString(),
      rawPayload: {},
    };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    await new Promise<void>((res) => ws.on("open", res));

    let resolveEscalated!: (e: WsEvent) => void;
    let rejectEscalated!: (err: Error) => void;
    const escalatedArrived = new Promise<WsEvent>((res, rej) => {
      resolveEscalated = res;
      rejectEscalated = rej;
    });
    const timer = setTimeout(
      () => rejectEscalated(new Error("timeout: no ESCALATED event")),
      10_000,
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as WsEvent;
      if (msg.type === "ESCALATED" && msg.payload["sessionId"] === sessionId) {
        clearTimeout(timer);
        resolveEscalated(msg);
      }
    });

    await enqueueJob({ alert, sessionId, trigger: "alert" });

    // The loop parks on the approval gate; reject it via REST.
    const incidentId = await waitForPendingApproval("restart_container");
    const rejectRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${incidentId}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "test" }),
      },
    );
    expect(rejectRes.status).toBe(200);

    const event = await escalatedArrived;
    ws.close();

    expect(String(event.payload["reason"])).toMatch(/rejected/i);
    expect(writeIncidentCalls.length).toBeGreaterThanOrEqual(1);
    const record = writeIncidentCalls[writeIncidentCalls.length - 1];
    expect(record?.["outcome"]).toBe("escalated");
    expect(String(record?.["rootCause"])).toMatch(/rejected/i);
  });

  it("tool budget exhaustion escalates: writes incident and emits ESCALATED", async () => {
    writeIncidentCalls.length = 0;
    mockCreateProvider.mockImplementationOnce(makeToolLoopProvider);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    await new Promise<void>((res) => ws.on("open", res));

    let targetSessionId: string | undefined;
    let resolveEscalated!: (e: WsEvent) => void;
    let rejectEscalated!: (err: Error) => void;
    const escalatedArrived = new Promise<WsEvent>((res, rej) => {
      resolveEscalated = res;
      rejectEscalated = rej;
    });
    const timer = setTimeout(
      () => rejectEscalated(new Error("timeout: no ESCALATED event")),
      10_000,
    );
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as WsEvent;
      if (
        msg.type === "ESCALATED" &&
        (!targetSessionId || msg.payload["sessionId"] === targetSessionId)
      ) {
        clearTimeout(timer);
        resolveEscalated(msg);
      }
    });

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Investigate forever." }),
    });
    expect(res.status).toBe(202);
    ({ sessionId: targetSessionId } = (await res.json()) as {
      sessionId: string;
    });

    const event = await escalatedArrived;
    ws.close();

    expect(String(event.payload["reason"])).toMatch(/exceeded/i);
    expect(writeIncidentCalls.length).toBeGreaterThanOrEqual(1);
    expect(writeIncidentCalls[writeIncidentCalls.length - 1]?.["outcome"]).toBe(
      "escalated",
    );
  });

  async function waitForPendingApproval(toolName: string): Promise<string> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await fetch(`http://127.0.0.1:${port}/incidents/pending`);
      const body = (await res.json()) as {
        pending: Array<{ incidentId: string; toolName: string; token: string }>;
      };
      const match = body.pending.find(
        (p) => p.toolName === toolName && p.token === TEST_TOKEN,
      );
      if (match) return match.incidentId;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout: ${toolName} approval never became pending`);
  }
});
