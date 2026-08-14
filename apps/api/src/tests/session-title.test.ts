import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import type { ConsoleEvent, NormalizedAlert } from "@nightwarden/shared";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import {
  mockCreateProvider,
  mockCreateTitleProvider,
} from "./llm-factory-mock.js";
import { createContractFakeProvider } from "./contract-fake-provider.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { registerSessionRoutes } from "../session/routes.js";
import { subscribeConsole } from "../session/bus.js";
import { createSession, getSession } from "../db/sessions.js";
import type { ResolvedLLMConfig } from "@nightwarden/shared";

// Title generation only runs inside a configured session, so the test states
// that precondition rather than depending on what an empty config returns.
function configuredConfig(): ResolvedLLMConfig {
  return {
    provider: "anthropic",
    model: "test-model",
    maxOutputTokens: 4096,
    maxRetries: 0,
    requestTimeoutMs: 10_000,
    reasoningLevel: null,
    reasoning: {
      label: "Effort",
      levels: [
        { value: "high", label: "High" },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      defaultLevel: "high",
      canDisable: true,
    },
  };
}
import {
  generateSessionTitle,
  buildAlertTitleSource,
} from "../session/title.js";
import { mountApi } from "./api-server.js";

function scriptTitleOnce(text: string): void {
  mockCreateTitleProvider.mockImplementationOnce(() =>
    createContractFakeProvider([{ toolUses: [], text }]),
  );
}

function seedSession(sessionId: string, title: string): void {
  createSession({ sessionId, title, createdAt: new Date().toISOString() });
}

describe("session title generation", () => {
  let cleanupDb: () => void;
  let server: FastifyInstance;
  let port: number;
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

  it("writes the refined title to the row and publishes SESSION_TITLE_UPDATED", async () => {
    scriptTitleOnce('"Checkout Latency Spike".');
    const sessionId = "sess-title-1";
    seedSession(sessionId, "Why is checkout slow this morning?");

    const events: ConsoleEvent[] = [];
    const unsubscribe = subscribeConsole((e) => events.push(e));
    await generateSessionTitle(
      sessionId,
      "Why is checkout slow this morning?",
      configuredConfig(),
    );
    unsubscribe();

    expect(getSession(sessionId)?.title).toBe("Checkout Latency Spike");
    const titleEvent = events.find((e) => e.type === "SESSION_TITLE_UPDATED");
    expect(titleEvent?.payload).toMatchObject({
      sessionId,
      title: "Checkout Latency Spike",
    });
  });

  // Without the run's retry policy one provider blip strands a session on its
  // temporary title, which is the row's most prominent field.
  it("rides out a transient provider error without touching the run's stream", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const provider = createContractFakeProvider([
      { toolUses: [], text: '"Checkout Latency Spike"' },
    ]);
    let attempts = 0;
    mockCreateTitleProvider.mockImplementationOnce(() => ({
      ...provider,
      chat: (...args: Parameters<typeof provider.chat>) => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(
            new OpenAI.APIConnectionError({ message: "down" }),
          );
        }
        const [schemas, onDelta, signal] = args;
        return provider.chat(schemas, onDelta, signal);
      },
    }));

    const sessionId = "sess-title-retry";
    seedSession(sessionId, "Why is checkout slow this morning?");
    const events: ConsoleEvent[] = [];
    const unsubscribe = subscribeConsole((e) => events.push(e));

    const pending = generateSessionTitle(
      sessionId,
      "Why is checkout slow this morning?",
      configuredConfig(),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    unsubscribe();
    vi.useRealTimers();

    expect(attempts).toBe(2);
    expect(getSession(sessionId)?.title).toBe("Checkout Latency Spike");
    // The stream is the investigation's; a title retry is logged, never sent.
    expect(events.some((e) => e.type === "RUN_RETRYING")).toBe(false);
  });

  it("sends the message as quoted material with reasoning off, not as a live turn", async () => {
    const provider = createContractFakeProvider([
      { toolUses: [], text: "Greeting" },
    ]);
    mockCreateTitleProvider.mockImplementationOnce(() => provider);
    const sessionId = "sess-title-framing";
    seedSession(sessionId, "temp");

    await generateSessionTitle(
      sessionId,
      "Hey there, how's it going?",
      configuredConfig(),
    );

    const framed: unknown = provider.start.mock.calls[0]?.[0];
    expect(framed).toContain("Hey there, how's it going?");
    expect(framed).toContain("<content>");
    expect(framed).not.toBe("Hey there, how's it going?");

    const call = mockCreateTitleProvider.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({ maxOutputTokens: 1024 });
    expect(call?.[3]).toEqual({ reasoning: "off" });
    expect(getSession(sessionId)?.title).toBe("Greeting");
  });

  it("strips trailing punctuation, including after the word cap", async () => {
    scriptTitleOnce("Identity Inquiry,");
    const sessionId = "sess-title-comma";
    seedSession(sessionId, "temp");
    await generateSessionTitle(sessionId, "who are you?", configuredConfig());
    expect(getSession(sessionId)?.title).toBe("Identity Inquiry");

    scriptTitleOnce("One Two Three Four, Five");
    const sessionId2 = "sess-title-comma-2";
    seedSession(sessionId2, "temp");
    await generateSessionTitle(sessionId2, "some question", configuredConfig());
    expect(getSession(sessionId2)?.title).toBe("One Two Three Four");
  });

  it("caps the refined title at four words", async () => {
    scriptTitleOnce("Redis Ran Out Of Memory Again");
    const sessionId = "sess-title-2";
    seedSession(sessionId, "temp");

    await generateSessionTitle(sessionId, "redis is oom", configuredConfig());

    expect(getSession(sessionId)?.title).toBe("Redis Ran Out Of");
  });

  it("leaves the title untouched when the model returns nothing usable", async () => {
    scriptTitleOnce("   ");
    const sessionId = "sess-title-3";
    seedSession(sessionId, "original temp title");

    await generateSessionTitle(sessionId, "some question", configuredConfig());

    expect(getSession(sessionId)?.title).toBe("original temp title");
  });

  it("builds an alert title source capped to the first ten alerts", () => {
    const alerts = Array.from({ length: 14 }, (_, i): NormalizedAlert => ({
      sourceAlertId: `a-${i}`,
      labels: {
        alertname: "cpu_high",
        severity: "critical",
        container: `svc-${i}`,
      },
      alertType: "cpu_high",
      severity: "critical",
      firedAt: "2024-01-01T00:00:00Z",
      annotations: {},
      generatorURL: null,
      values: {},
      rawPayload: {},
    }));

    const lines = buildAlertTitleSource(alerts).split("\n");

    expect(lines).toHaveLength(10);
    // The labels themselves, not a resolved key: the title model gets more to
    // work with from what the alert said than from a key assembled after the fact.
    expect(lines[0]).toBe("[cpu_high] container=svc-0 (critical)");
  });

  it("refines the title end-to-end when a chat session starts", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([{ toolUses: [], text: "Done." }]),
    );
    scriptTitleOnce("Checkout Latency Spike");
    const events: ConsoleEvent[] = [];
    const unsubscribe = subscribeConsole((e) => events.push(e));

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Why is checkout slow?" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Fire-and-forget: wait on the row, not on the run finishing.
    await waitFor(
      () => getSession(sessionId)?.title === "Checkout Latency Spike",
    );
    unsubscribe();
    const titleEvent = events.find((e) => e.type === "SESSION_TITLE_UPDATED");
    expect(titleEvent?.payload).toMatchObject({
      sessionId,
      title: "Checkout Latency Spike",
    });
  });
});
