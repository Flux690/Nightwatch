import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
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
          // A free-form text finish: no tool call ends the run successfully.
          return Promise.resolve({
            stopReason: "end_turn" as const,
            toolUses: [],
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

import { mintToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerChatRoutes } from "../chat/routes.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import {
  registerRunner,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";

// Wait for the console handler's `connected` ack, sent only after it subscribes
// to the event bus. Dispatch is now in-process and synchronous, so a run can
// publish before a subscriber that only waited for the socket `open` handshake;
// pre-subscribe events are correctly dropped (the transcript is durable).
function waitForConnected(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    const onMessage = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as { type: string };
      if (msg.type === "connected") {
        ws.off("message", onMessage);
        resolve();
      }
    };
    ws.on("message", onMessage);
  });
}

describe("console WS pipeline", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let TEST_TOKEN: string;
  let SESSION: string;
  const TEST_RUNNER_ID = "test-runner-1";

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = mintToken("test-runner").id;

    // Persistence is local now; the provider calls no runner tool here, so the
    // runner receives nothing. Resolve defensively for any stray command.
    registerRunner(
      TEST_TOKEN,
      TEST_RUNNER_ID,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: true,
          result: [],
        });
      },
      () => {},
    );

    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerConsoleWsRoutes(server);
    await registerChatRoutes(server);
    await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    unregisterRunner(TEST_TOKEN, TEST_RUNNER_ID);
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("delivers session_delta events then session_message, transcript loadable after", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        payload: Record<string, unknown>;
      };
      if (msg.type === "connected") return;
      events.push(msg);
    });

    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Is the system healthy?" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(typeof sessionId).toBe("string");

    // The POST dispatched the run in-process; the mocked investigation publishes
    // session_delta then session_message over the event bus to the console WS.
    // The run resolves in microtasks - possibly before this captured sessionId -
    // so buffer every event and poll for the match rather than racing arrival.
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
      ),
    );

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

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: Array<{
      type: string;
      payload: { sessionId: string; message?: { role: string } };
    }> = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as (typeof events)[number];
      if (msg.type === "connected") return;
      events.push(msg);
    });
    await waitForConnected(ws);

    // Each run persists exactly one assistant turn, so counting assistant
    // RUN_FINISHED events for the session distinguishes the first run (>=1) from
    // the resumed run (>=2) without racing the captured sessionId.
    const assistantFinishes = (sessionId: string): number =>
      events.filter(
        (e) =>
          e.type === "RUN_FINISHED" &&
          e.payload.sessionId === sessionId &&
          e.payload.message?.role === "assistant",
      ).length;

    // Start a new chat session (first run).
    const startRes = await fetch(
      `http://127.0.0.1:${port}/chat/${TEST_TOKEN}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "Is the system healthy?" }),
      },
    );
    expect(startRes.status).toBe(202);
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    await waitFor(() => assistantFinishes(sessionId) >= 1);

    // Resume the ended session with a follow-up message. The same sessionId
    // must come back - no new session is minted.
    const resumeRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({
          token: TEST_TOKEN,
          message: "Follow-up question.",
        }),
      },
    );
    expect(resumeRes.status).toBe(202);
    const resumeBody = (await resumeRes.json()) as { sessionId: string };
    expect(resumeBody.sessionId).toBe(sessionId);

    // The resumed run must emit a second assistant RUN_FINISHED (i.e. the new
    // turns are persisted - if snapshot() were not stateful this would time out).
    await waitFor(() => assistantFinishes(sessionId) >= 2);

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
