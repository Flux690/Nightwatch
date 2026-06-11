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
  ConsoleTextMessageContent,
  ConsoleRunFinished,
  RunnerCommandMessage,
} from "@nightwatch/shared";

const { mockCreateProvider } = vi.hoisted(() => {
  // Each createProvider() call returns a fresh, stateful provider instance so
  // that snapshot() reflects the messages accumulated via seed/start/chat/append.
  // The fixed-array mock would return seed.length items on resume, causing
  // persist() to skip all new messages (persistedCount == snap.length).
  const makeProvider = () => {
    type ProvMsg = {
      role: "user" | "assistant";
      content: string;
      providerContent: unknown;
    };
    const messages: ProvMsg[] = [];

    return {
      start: vi.fn((msg: string) => {
        messages.push({ role: "user", content: msg, providerContent: {} });
      }),
      seed: vi.fn((history: ProvMsg[]) => {
        messages.length = 0;
        messages.push(...history);
      }),
      snapshot: vi.fn((): ProvMsg[] => [...messages]),
      chat: vi.fn(
        (
          _tools: unknown,
          onDelta?: (d: { kind: string; text: string }) => void,
        ) => {
          onDelta?.({ kind: "text", text: "All " });
          onDelta?.({ kind: "text", text: "looks well." });
          messages.push({
            role: "assistant",
            content: "All looks well.",
            providerContent: {},
          });
          return Promise.resolve({
            stopReason: "tool_use" as const,
            toolUses: [
              {
                id: `conclude-${messages.length}`,
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
      appendUserMessage: vi.fn((msg: string) => {
        messages.push({ role: "user", content: msg, providerContent: {} });
      }),
    };
  };

  return {
    mockCreateProvider: vi.fn(makeProvider),
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
        msg.type === "RUN_FINISHED" &&
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
      (e): e is ConsoleTextMessageContent =>
        e.type === "TEXT_MESSAGE_CONTENT" &&
        e.payload["sessionId"] === sessionId,
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas[0].payload.sessionId).toBe(sessionId);

    const messages = events.filter(
      (e): e is ConsoleRunFinished =>
        e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
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

  it("resume of ended session seeds provider from persisted transcript", async () => {
    mockCreateProvider.mockClear();

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    await new Promise<void>((res) => ws.on("open", res));

    let targetSessionId: string | undefined;
    let firstRunDone = false;
    let resolveFirstRun!: () => void;
    let resolveResumedRun!: () => void;
    const firstRunComplete = new Promise<void>((r) => {
      resolveFirstRun = r;
    });
    const resumedRunComplete = new Promise<void>((r) => {
      resolveResumedRun = r;
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        payload: { sessionId: string; message: { role: string } };
      };
      if (msg.type !== "RUN_FINISHED") return;
      if (msg.payload.sessionId !== targetSessionId) return;
      // The first run ends when the assistant turn is persisted. Waiting only
      // for the assistant turn (not the user turn) prevents the user message
      // from the same run from prematurely resolving resumedRunComplete.
      if (!firstRunDone && msg.payload.message.role === "assistant") {
        firstRunDone = true;
        resolveFirstRun();
      } else if (firstRunDone) {
        resolveResumedRun();
      }
    });

    // Start a new chat session (first run).
    const startRes = await fetch(
      `http://127.0.0.1:${port}/chat/${TEST_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Is the system healthy?" }),
      },
    );
    expect(startRes.status).toBe(202);
    const { sessionId } = (await startRes.json()) as { sessionId: string };
    targetSessionId = sessionId;

    await Promise.race([
      firstRunComplete,
      new Promise<void>((_, rej) =>
        setTimeout(
          () => rej(new Error("timeout: first run did not complete")),
          10_000,
        ),
      ),
    ]);

    // Resume the ended session with a follow-up message. The same sessionId
    // must come back - no new session is minted.
    const resumeRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: TEST_TOKEN,
          message: "Follow-up question.",
        }),
      },
    );
    expect(resumeRes.status).toBe(202);
    const resumeBody = (await resumeRes.json()) as { sessionId: string };
    expect(resumeBody.sessionId).toBe(sessionId);

    // The resumed run must emit RUN_FINISHED (i.e. the new turns are
    // persisted - if snapshot() were not stateful this would time out).
    await Promise.race([
      resumedRunComplete,
      new Promise<void>((_, rej) =>
        setTimeout(
          () =>
            rej(new Error("timeout: resumed run did not emit RUN_FINISHED")),
          10_000,
        ),
      ),
    ]);

    ws.close();

    // createProvider was called once per run.
    expect(mockCreateProvider.mock.calls.length).toBe(2);

    // The second provider (resume run) must have been seeded with the two
    // messages persisted by the first run (user + assistant), then had the
    // follow-up appended as a user turn.
    const resumeProvider = mockCreateProvider.mock.results[1]?.value as {
      seed: ReturnType<typeof vi.fn>;
      appendUserMessage: ReturnType<typeof vi.fn>;
    };
    expect(resumeProvider.seed).toHaveBeenCalledOnce();
    const [seededHistory] = resumeProvider.seed.mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    expect(seededHistory).toHaveLength(2);
    expect(seededHistory[0]).toMatchObject({ role: "user" });
    expect(seededHistory[1]).toMatchObject({ role: "assistant" });
    expect(resumeProvider.appendUserMessage).toHaveBeenCalledWith(
      "Follow-up question.",
    );
  });
});
