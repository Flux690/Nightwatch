import { harness, type Harness } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

import { clearTestLLM, configureTestLLM } from "./temp-db.js";
import { waitFor } from "./wait.js";

import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";

describe("chat routes — session-uuid-addressed, owner-cookie-gated", () => {
  let nw: Harness;
  let port: number;
  let SESSION: string;

  beforeAll(async () => {
    nw = await harness({ routes: [registerSessionRoutes] });
    ({ port } = nw);
    SESSION = nw.session;
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  const post = async (body: unknown): Promise<Response> =>
    await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `${SESSION}` },
      body: JSON.stringify(body),
    });

  it("POST /chat returns 400 when message is missing", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    // Names the field and what it needs, rather than a type mismatch the
    // caller has to translate back into "you left it out".
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/message is required/i);
  });

  it("POST /chat refuses an investigation and says an alert opens one", async () => {
    const res = await post({
      message: "why is checkout slow",
      kind: "investigation",
    });
    expect(res.status).toBe(400);
    // The refusal has to carry its reason: a caller told only that the value is
    // wrong will try another spelling rather than sending an alert.
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/alert/i);
  });

  it("POST /chat creates a session and returns its uuid", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({ message: "Is the system healthy?" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);

    // Wait for the run to complete so subsequent tests start clean.
    await waitFor(async () => !(await dispatcher.isSessionRunning(sessionId)));
  });

  it("POST /chat/:id (old route) returns 404 — token-scoped chat removed", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat/some-token-id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
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
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({ message: "How are things?" }),
    });
    expect(startRes.status).toBe(202);
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    // Wait for first run to finish before continuing.
    await waitFor(async () => !(await dispatcher.isSessionRunning(sessionId)));

    // Continue the session — no token in body.
    const contRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({ message: "Any alerts?" }),
      },
    );
    expect(contRes.status).toBe(202);
    const cont = (await contRes.json()) as { sessionId: string };
    expect(cont.sessionId).toBe(sessionId);

    await waitFor(async () => !(await dispatcher.isSessionRunning(sessionId)));
  });

  it("POST /chat refuses with 503 when no LLM is configured, naming what to pick", async () => {
    await clearTestLLM();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({ message: "why is checkout slow" }),
      });

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/no LLM is configured/i);
    } finally {
      await configureTestLLM();
    }
  });

  it("POST /sessions/:id/messages returns 404 for an unknown session", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/sessions/unknown-uuid/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({ message: "hello" }),
      },
    );
    expect(res.status).toBe(404);
  });
});
