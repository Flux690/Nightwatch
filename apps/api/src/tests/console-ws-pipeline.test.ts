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
} from "@nightwatch/shared";

// --- Hoisted mocks (must be at top, before any imports that load these modules) ---

const { mockSendCommand, mockCreateProvider } = vi.hoisted(() => {
  const storedMessages: Record<string, unknown[]> = {};

  const sendCmd = vi.fn(
    (_token: string, command: string, params: Record<string, unknown>) => {
      if (command === "append_session_message") {
        const sid = (params as { message: { sessionId: string } }).message
          .sessionId;
        storedMessages[sid] ??= [];
        storedMessages[sid].push(params["message"]);
        return Promise.resolve({ ok: true });
      }
      if (command === "get_session_messages") {
        const sid = (params as { sessionId: string }).sessionId;
        return Promise.resolve(storedMessages[sid] ?? []);
      }
      // write_incident, telemetry, history — all succeed silently
      return Promise.resolve([]);
    },
  );

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
    mockSendCommand: sendCmd,
    mockCreateProvider: vi.fn(() => provider),
  };
});

vi.mock("../ws/router.js", () => ({
  sendCommand: mockSendCommand,
  registerRunner: vi.fn(),
  unregisterRunner: vi.fn(),
  resolveCommand: vi.fn(),
  RunnerOfflineError: class RunnerOfflineError extends Error {
    constructor(token: string) {
      super(`Runner for token ${token} is offline`);
      this.name = "RunnerOfflineError";
    }
  },
}));

vi.mock("../llm/factory.js", () => ({
  createProvider: mockCreateProvider,
}));

// --- Imports that depend on mocked modules (after vi.mock calls) ---

import { db } from "../db/client.js";
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerChatRoutes } from "../chat/routes.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import { startWorker } from "../jobs/worker.js";

// ---

describe("console WS pipeline", () => {
  let server: FastifyInstance;
  let worker: Worker;
  let port: number;
  let userId: string;
  const TEST_TOKEN = `test-${randomUUID()}`;

  beforeAll(async () => {
    // Seed minimal DB fixture: user + installation
    const user = await db.user.create({
      data: { email: `test-${randomUUID()}@nightwatch-test.local` },
    });
    userId = user.id;
    await db.installation.create({
      data: { token: TEST_TOKEN, userId, hostname: "test-runner" },
    });

    // Minimal server: console WS + chat + sessions routes
    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerConsoleWsRoutes(server);
    await registerChatRoutes(server);
    await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;

    worker = startWorker();
    await (
      worker as unknown as { waitUntilReady: () => Promise<void> }
    ).waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await server.close();
    await db.installation.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  });

  it("delivers session_delta events then session_message, transcript loadable after", async () => {
    // Connect WS client
    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];

    let resolveMessage: () => void = () => {};
    const firstMessageArrived = new Promise<void>((res) => {
      resolveMessage = res;
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        payload: Record<string, unknown>;
      };
      if (msg.type === "connected") return;
      events.push(msg);
      if (msg.type === "session_message") resolveMessage();
    });

    await new Promise<void>((res) => ws.on("open", res));

    // Start a chat session
    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Is the system healthy?" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(typeof sessionId).toBe("string");

    // Wait for first session_message (signals at least one turn persisted)
    await Promise.race([
      firstMessageArrived,
      new Promise<void>((_, rej) =>
        setTimeout(
          () => rej(new Error("timeout: no session_message after 15s")),
          15_000,
        ),
      ),
    ]);

    ws.close();

    // Delta events arrived before session_message
    const deltas = events.filter(
      (e): e is ConsoleSessionDelta => e.type === "session_delta",
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas[0].payload.sessionId).toBe(sessionId);

    // session_message events arrived
    const messages = events.filter(
      (e): e is ConsoleSessionMessage => e.type === "session_message",
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].payload.sessionId).toBe(sessionId);

    // Transcript loadable via REST
    const transcriptRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}?token=${TEST_TOKEN}`,
    );
    expect(transcriptRes.status).toBe(200);
    const transcript = (await transcriptRes.json()) as unknown[];
    expect(transcript.length).toBeGreaterThan(0);
  });
});
