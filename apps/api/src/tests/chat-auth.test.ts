import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// Minimal scripted provider: finishes in one free-form turn so the loop exits
// without runner tools, letting tests focus on the chat route boundary.
const { mockCreateProvider } = vi.hoisted(() => {
  type Msg = {
    role: "user" | "assistant";
    content: string;
    providerContent: unknown;
  };
  const makeProvider = () => {
    const messages: Msg[] = [];
    return {
      start: vi.fn((msg: string) => {
        messages.push({ role: "user", content: msg, providerContent: {} });
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
          onDelta?.({ kind: "text", text: "Done." });
          messages.push({
            role: "assistant",
            content: "Done.",
            providerContent: {},
          });
          return Promise.resolve({
            stopReason: "end_turn" as const,
            toolUses: [],
            text: "Done.",
          });
        },
      ),
      appendToolResults: vi.fn(),
      appendUserMessage: vi.fn((msg: string) => {
        messages.push({ role: "user", content: msg, providerContent: {} });
      }),
    };
  };
  return { mockCreateProvider: vi.fn(makeProvider) };
});

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { registerChatRoutes } from "../chat/routes.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import { dispatcher } from "../dispatch/dispatcher.js";

describe("chat routes — session-uuid-addressed, owner-cookie-gated", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();

    server = Fastify({ logger: false });
    await registerChatRoutes(server);
    await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("POST /chat returns 401 without a valid nw_auth cookie", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /chat returns 400 when message is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /chat creates a session and returns its uuid", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
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
    expect(sessionId.length).toBeGreaterThan(0);

    // Wait for the run to complete so subsequent tests start clean.
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
  });

  it("POST /chat/:tokenId (old route) returns 404 — token-scoped chat removed", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/chat/some-token-id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /sessions/:id/messages returns 401 without a cookie", async () => {
    // Start a real session first.
    const startRes = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Starting." }),
    });
    const { sessionId } = (await startRes.json()) as { sessionId: string };
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));

    const res = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Follow-up." }),
      },
    );
    expect(res.status).toBe(401);
  });

  it("POST /sessions/:id/messages continues the session by uuid, returning the same sessionId", async () => {
    // Start a session.
    const startRes = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "How are things?" }),
    });
    expect(startRes.status).toBe(202);
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    // Wait for first run to finish before continuing.
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));

    // Continue the session — no token in body.
    const contRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "Any alerts?" }),
      },
    );
    expect(contRes.status).toBe(202);
    const cont = (await contRes.json()) as { sessionId: string };
    expect(cont.sessionId).toBe(sessionId);

    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
  });

  it("POST /sessions/:id/messages returns 404 for an unknown session", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/sessions/unknown-uuid/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "hello" }),
      },
    );
    expect(res.status).toBe(404);
  });
});
