import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import OpenAI from "openai";
import type { ConsoleEvent } from "@nightwatch/shared";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import {
  createContractFakeProvider,
  type ContractFakeProvider,
} from "./contract-fake-provider.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { expectInvestigationFailure } from "./setup.js";
import {
  connectConsoleEvents,
  type ConsoleEventsClient,
} from "./console-events-helper.js";
import { registerConsoleEventRoutes } from "../session/events.js";
import { registerSessionRoutes } from "../session/routes.js";
import { getSessionMessages } from "../db/sessions.js";

function providerError(status: number, body?: Record<string, unknown>): Error {
  return OpenAI.APIError.generate(
    status,
    { error: body ?? { message: "boom" } },
    "boom",
    new Headers(),
  );
}

function healthyProvider(text: string): ContractFakeProvider {
  return createContractFakeProvider([{ toolUses: [], text }]);
}

describe("run failure surfacing (dispatch -> retry -> transcript -> SSE)", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;
  let client: ConsoleEventsClient<ConsoleEvent>;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    server = Fastify({ logger: false, forceCloseConnections: true });
    await registerConsoleEventRoutes(server);
    await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
    client = await connectConsoleEvents<ConsoleEvent>(port, SESSION);
  });

  afterAll(async () => {
    client.close();
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startChat(message: string): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    return sessionId;
  }

  function retryEventsFor(sessionId: string) {
    return client.events.filter(
      (e) => e.type === "RUN_RETRYING" && e.payload.sessionId === sessionId,
    );
  }

  it("rides out transient 502s and finishes without an error row", async () => {
    const fake = healthyProvider("Recovered fine.");
    fake.chat
      .mockRejectedValueOnce(providerError(502))
      .mockRejectedValueOnce(providerError(502));
    mockCreateProvider.mockImplementation(() => fake);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sessionId = await startChat("summarize the codebase");

    await waitFor(() => retryEventsFor(sessionId).length >= 1);
    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => retryEventsFor(sessionId).length >= 2);
    await vi.advanceTimersByTimeAsync(15_000);

    await waitFor(() =>
      client.events.find(
        (e) => e.type === "RUN_FINISHED" && e.payload.sessionId === sessionId,
      ),
    );

    const first = retryEventsFor(sessionId)[0];
    expect(first?.type === "RUN_RETRYING" && first.payload.summary).toBe(
      "Provider error (502). Retrying in 5s - attempt 2 of 4.",
    );
    const roles = getSessionMessages(sessionId).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("persists a plain-language error row when retries run out, and publishes it", async () => {
    const fake = healthyProvider("never reached");
    fake.chat.mockRejectedValue(
      providerError(502, {
        message: "Provider returned error",
        metadata: { provider_name: "Poolside", is_byok: false },
      }),
    );
    mockCreateProvider.mockImplementation(() => fake);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const sessionId = await startChat("what is down?");

    for (const [i, delay] of [5_000, 15_000, 45_000].entries()) {
      await waitFor(() => retryEventsFor(sessionId).length >= i + 1);
      await vi.advanceTimersByTimeAsync(delay);
    }

    const failed = await waitFor(() =>
      client.events.find(
        (e) => e.type === "RUN_FAILED" && e.payload.sessionId === sessionId,
      ),
    );
    if (failed.type !== "RUN_FAILED") throw new Error("unreachable");
    expect(failed.payload.message.role).toBe("error");
    expect(failed.payload.message.content).toContain("server problem");
    expect(failed.payload.message.content).toContain(
      "(HTTP 502 from Poolside)",
    );

    const messages = getSessionMessages(sessionId);
    expect(messages.map((m) => [m.seq, m.role])).toEqual([
      [0, "user"],
      [1, "error"],
    ]);
    expectInvestigationFailure();
  });

  it("fails immediately on a 401 - no retries, key guidance in the transcript", async () => {
    const fake = healthyProvider("never reached");
    fake.chat.mockRejectedValue(providerError(401));
    mockCreateProvider.mockImplementation(() => fake);

    const sessionId = await startChat("hello");

    const failed = await waitFor(() =>
      client.events.find(
        (e) => e.type === "RUN_FAILED" && e.payload.sessionId === sessionId,
      ),
    );
    if (failed.type !== "RUN_FAILED") throw new Error("unreachable");
    expect(failed.payload.message.content).toContain("rejected the API key");
    expect(retryEventsFor(sessionId)).toHaveLength(0);
    expectInvestigationFailure();
  });

  it("resume after a failure: dead exchange is not replayed, seq continues past it", async () => {
    const failing = healthyProvider("never reached");
    failing.chat.mockRejectedValue(providerError(401));
    mockCreateProvider.mockImplementation(() => failing);

    const sessionId = await startChat("first question");
    await waitFor(() =>
      client.events.find(
        (e) => e.type === "RUN_FAILED" && e.payload.sessionId === sessionId,
      ),
    );

    const healthy = healthyProvider("Fresh answer.");
    mockCreateProvider.mockImplementation(() => healthy);
    const res = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "try again" }),
      },
    );
    expect(res.status).toBe(202);

    await waitFor(() =>
      getSessionMessages(sessionId).some((m) => m.role === "assistant"),
    );

    // The failed exchange stays in the transcript but never reached the model:
    // the provider was started fresh, not seeded.
    expect(healthy.seed).not.toHaveBeenCalled();
    expect(healthy.start).toHaveBeenCalledWith("try again");
    expect(getSessionMessages(sessionId).map((m) => [m.seq, m.role])).toEqual([
      [0, "user"],
      [1, "error"],
      [2, "user"],
      [3, "assistant"],
    ]);
    expectInvestigationFailure();
  });
});
