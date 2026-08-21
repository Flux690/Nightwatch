import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// Minimal scripted provider: finishes in one free-form turn so the loop exits
// without runner tools, letting tests focus on the chat route boundary.
vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import { createContractFakeProvider } from "./contract-fake-provider.js";

// Every run finishes in one free-form turn so the loop exits without runner
// tools, letting these tests focus on the chat route boundary.
mockCreateProvider.mockImplementation(() =>
  createContractFakeProvider([{ toolUses: [], text: "Done." }]),
);

import { clearTestLLM, configureTestLLM, useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";

import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";
import { mountApi } from "./api-server.js";

describe("chat routes — session-uuid-addressed, owner-cookie-gated", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();

    server = Fastify({ logger: false });
    await mountApi(server, registerSessionRoutes);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("POST /chat returns 400 when message is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
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
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
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

  it("POST /chat/:id (old route) returns 404 — token-scoped chat removed", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/some-token-id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /sessions/:id/messages continues the session by uuid, returning the same sessionId", async () => {
    // Start a session.
    const startRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
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
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`,
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

  it("POST /chat refuses with 503 when no LLM is configured, naming what to pick", async () => {
    clearTestLLM();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "why is checkout slow" }),
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/no LLM is configured/i);
    } finally {
      configureTestLLM();
    }
  });

  it("POST /sessions/:id/messages returns 404 for an unknown session", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/sessions/unknown-uuid/messages`,
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
