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

const VALID_INPUT = {
  rootCause: {
    summary: "Test root cause.",
    evidence: ["log line 1"],
    contributingFactors: null,
  },
  recommendedAction: null,
  escalateIfRejected: false,
  investigationSteps: ["checked logs"],
};

const INVALID_INPUT = { badField: "missing required keys" };

function makeProvider(finalResponseInput: Record<string, unknown>) {
  type Msg = {
    role: "user" | "assistant";
    content: string;
    providerContent: unknown;
  };
  const messages: Msg[] = [];
  return {
    start: vi.fn((msg: string) => {
      messages.push({
        role: "user" as const,
        content: msg,
        providerContent: {},
      });
    }),
    seed: vi.fn(),
    snapshot: vi.fn((): Msg[] => [...messages]),
    chat: vi.fn(
      (
        _tools: unknown,
        onDelta?: (d: { kind: string; text: string }) => void,
      ) => {
        onDelta?.({ kind: "text", text: "Analysis done." });
        messages.push({
          role: "assistant" as const,
          content: "Analysis done.",
          providerContent: {},
        });
        return Promise.resolve({
          stopReason: "tool_use" as const,
          toolUses: [
            { id: "fr-1", name: "final_response", input: finalResponseInput },
          ],
          text: "Analysis done.",
        });
      },
    ),
    appendToolResults: vi.fn(),
    appendUserMessage: vi.fn(),
  };
}

// Each test calls mockImplementationOnce to inject its own provider instance.
const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import { db } from "../db/client.js";
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerChatRoutes } from "../chat/routes.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import { startWorker } from "../jobs/worker.js";
import {
  registerRunner,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";

describe("final_response terminal mechanism", () => {
  let server: FastifyInstance;
  let worker: Worker;
  let port: number;
  let userId: string;
  const TEST_TOKEN = `test-fr-${randomUUID()}`;
  const TEST_RUNNER_ID = "test-runner-fr";
  const storedMessages: Record<string, unknown[]> = {};
  const writeIncidentCalls: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    const user = await db.user.create({
      data: { email: `test-fr-${randomUUID()}@nightwatch-test.local` },
    });
    userId = user.id;
    await db.token.create({
      data: { token: TEST_TOKEN, userId, hostname: "test-fr-runner" },
    });

    registerRunner(TEST_TOKEN, TEST_RUNNER_ID, (raw: string) => {
      const msg = JSON.parse(raw) as RunnerCommandMessage;
      const { commandName, commandInput, correlationId } = msg.payload;
      if (commandName === "write_incident") {
        writeIncidentCalls.push(commandInput as Record<string, unknown>);
        resolveCommand({ correlationId, success: true, result: { ok: true } });
      } else if (commandName === "append_session_message") {
        const message = commandInput["message"] as { sessionId: string };
        storedMessages[message.sessionId] ??= [];
        storedMessages[message.sessionId].push(commandInput["message"]);
        resolveCommand({ correlationId, success: true, result: { ok: true } });
      } else if (commandName === "get_session_messages") {
        const sessionId = commandInput["sessionId"] as string;
        resolveCommand({
          correlationId,
          success: true,
          result: storedMessages[sessionId] ?? [],
        });
      } else {
        resolveCommand({ correlationId, success: true, result: [] });
      }
    });

    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerConsoleWsRoutes(server);
    await registerChatRoutes(server);
    await registerSessionRoutes(server);
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

  it("valid final_response concludes the investigation and persists the incident", async () => {
    mockCreateProvider.mockImplementationOnce(() => makeProvider(VALID_INPUT));
    writeIncidentCalls.length = 0;

    let resolveWriteIncident!: () => void;
    const writeIncidentArrived = new Promise<void>((res) => {
      resolveWriteIncident = res;
    });

    // Patch the runner callback to resolve the promise on write_incident.
    // The runner was registered above; we detect arrival via the shared array.
    const poll = setInterval(() => {
      if (writeIncidentCalls.length > 0) {
        clearInterval(poll);
        resolveWriteIncident();
      }
    }, 10);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Something went wrong." }),
    });
    expect(res.status).toBe(202);

    await Promise.race([
      writeIncidentArrived,
      new Promise<void>((_, rej) =>
        setTimeout(() => {
          clearInterval(poll);
          rej(new Error("timeout: write_incident not received"));
        }, 10_000),
      ),
    ]);

    expect(writeIncidentCalls).toHaveLength(1);
    expect(writeIncidentCalls[0]).toMatchObject({
      alertType: expect.any(String),
      outcome: "finding",
    });
  });

  it("invalid final_response schema escalates without persisting an incident", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      makeProvider(INVALID_INPUT),
    );
    writeIncidentCalls.length = 0;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    let targetSessionId: string | undefined;
    let resolveRunFinished!: () => void;
    const runFinished = new Promise<void>((res) => {
      resolveRunFinished = res;
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        payload: { sessionId: string };
      };
      if (
        msg.type === "RUN_FINISHED" &&
        msg.payload.sessionId === targetSessionId
      ) {
        resolveRunFinished();
      }
    });
    await new Promise<void>((res) => ws.on("open", res));

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Something exploded." }),
    });
    expect(res.status).toBe(202);
    ({ sessionId: targetSessionId } = (await res.json()) as {
      sessionId: string;
    });

    await Promise.race([
      runFinished,
      new Promise<void>((_, rej) =>
        setTimeout(() => rej(new Error("timeout: no RUN_FINISHED")), 10_000),
      ),
    ]);

    // Short wait: after RUN_FINISHED the loop has already decided escalate vs conclude.
    // escalate() now writes an incident (escalated outcome) — exactly one call.
    await new Promise((r) => setTimeout(r, 200));

    ws.close();
    expect(writeIncidentCalls).toHaveLength(1);
    expect(writeIncidentCalls[0]).toMatchObject({
      alertType: expect.any(String),
      outcome: "escalated",
    });
  });
});
