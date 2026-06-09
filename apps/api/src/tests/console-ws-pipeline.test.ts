import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { Worker } from "bullmq";
import type {
  ConsoleSessionDelta,
  ConsoleSessionMessage,
  RunnerCommandMessage,
} from "@nightwatch/shared";

const { mockCreateProvider } = vi.hoisted(() => {
  const provider = {
    start: vi.fn(),
    seed: vi.fn(),
    snapshot: vi.fn(() => [
      { role: "user", content: "Is the system healthy?", providerContent: {} },
      {
        role: "assistant",
        content: "All looks well.",
        providerContent: {},
      },
    ]),
    chat: vi.fn(
      (
        _tools: unknown,
        onDelta?: (d: { kind: string; text: string }) => void,
      ) => {
        onDelta?.({ kind: "text", text: "All " });
        onDelta?.({ kind: "text", text: "looks well." });
        return Promise.resolve({
          stopReason: "tool_use" as const,
          toolUses: [
            {
              id: "conclude-1",
              name: "conclude",
              input: {
                rootCause: {
                  summary: "No issues detected.",
                  evidence: ["Metrics within normal range"],
                  contributingFactors: null,
                },
                recommendedAction: null,
                escalateIfRejected: false,
                investigationSteps: ["Checked system metrics"],
              },
            },
          ],
          text: "All looks well.",
        });
      },
    ),
    appendToolResults: vi.fn(),
    appendUserMessage: vi.fn(),
  };

  return {
    mockCreateProvider: vi.fn(() => provider),
  };
});

vi.mock("../llm/factory.js", () => ({
  createProvider: mockCreateProvider,
}));

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

describe("console WS pipeline", () => {
  let server: FastifyInstance;
  let worker: Worker;
  let port: number;
  let userId: string;
  const TEST_TOKEN = `test-${randomUUID()}`;
  const TEST_RUNNER_ID = "test-runner-1";
  const storedMessages: Record<string, unknown[]> = {};

  beforeAll(async () => {
    const user = await db.user.create({
      data: { email: `test-${randomUUID()}@nightwatch-test.local` },
    });
    userId = user.id;
    await db.token.create({
      data: { token: TEST_TOKEN, userId, hostname: "test-runner" },
    });

    registerRunner(TEST_TOKEN, TEST_RUNNER_ID, (raw: string) => {
      const msg = JSON.parse(raw) as RunnerCommandMessage;
      const { commandName, commandInput, correlationId } = msg.payload;

      if (commandName === "append_session_message") {
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

    // The test owns the only worker on its isolated Redis db, so it always wins
    // the job and runs the mocked provider in-process.
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

  it("delivers session_delta events then session_message, transcript loadable after", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];

    let targetSessionId: string | undefined;
    let resolveFirstMessage: () => void = () => {};
    const firstMessageArrived = new Promise<void>((res) => {
      resolveFirstMessage = res;
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        payload: Record<string, unknown>;
      };
      if (msg.type === "connected") return;
      events.push(msg);
      // Redis pub/sub is instance-global, so a concurrent dev investigation
      // could publish here; only react to this test's own session.
      if (
        msg.type === "session_message" &&
        msg.payload["sessionId"] === targetSessionId
      ) {
        resolveFirstMessage();
      }
    });

    await new Promise<void>((res) => ws.on("open", res));

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Is the system healthy?" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(typeof sessionId).toBe("string");
    targetSessionId = sessionId;

    // The POST enqueued the job; the test's worker (sole consumer of its
    // isolated Redis db) runs the mocked investigation, which publishes
    // session_delta then session_message over Redis pub/sub to the console WS.
    await Promise.race([
      firstMessageArrived,
      new Promise<void>((_, rej) =>
        setTimeout(
          () => rej(new Error("timeout: no session_message after 10s")),
          10_000,
        ),
      ),
    ]);

    ws.close();

    const deltas = events.filter(
      (e): e is ConsoleSessionDelta =>
        e.type === "session_delta" && e.payload["sessionId"] === sessionId,
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas[0].payload.sessionId).toBe(sessionId);

    const messages = events.filter(
      (e): e is ConsoleSessionMessage =>
        e.type === "session_message" && e.payload["sessionId"] === sessionId,
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].payload.sessionId).toBe(sessionId);

    const transcriptRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}?token=${TEST_TOKEN}`,
    );
    expect(transcriptRes.status).toBe(200);
    const transcript = (await transcriptRes.json()) as unknown[];
    expect(transcript.length).toBeGreaterThan(0);
  });
});
