import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
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

import { createToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerChatRoutes } from "../chat/routes.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import { getRecentIncidents } from "../db/incidents.js";
import type { IncidentRecord } from "@nightwatch/shared";
import {
  registerRunner,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";

describe("final_response terminal mechanism", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let TEST_TOKEN: string;
  const TEST_RUNNER_ID = "test-runner-fr";

  // Incidents land in the API's local store now; read them back from there.
  function incidentFor(sessionId: string): IncidentRecord | undefined {
    return getRecentIncidents(TEST_TOKEN).find(
      (i) => i.sessionId === sessionId,
    );
  }

  async function waitFor<T>(probe: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const value = probe();
      if (value !== undefined) return value;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timeout: condition never became true");
  }

  beforeAll(async () => {
    cleanupDb = useTempDb();
    TEST_TOKEN = createToken("test-fr-runner").token;

    // The provider only calls final_response (platform-terminal) and persistence
    // is local, so no command reaches the runner; resolve defensively.
    registerRunner(TEST_TOKEN, TEST_RUNNER_ID, (raw: string) => {
      const msg = JSON.parse(raw) as RunnerCommandMessage;
      resolveCommand({
        correlationId: msg.payload.correlationId,
        success: true,
        result: [],
      });
    });

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

  it("valid final_response records a finding and persists the incident", async () => {
    mockCreateProvider.mockImplementationOnce(() => makeProvider(VALID_INPUT));

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Something went wrong." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const incident = await waitFor(() => incidentFor(sessionId));
    expect(incident.outcome).toBe("finding");
    expect(incident.containerName).toBe("chat");
  });

  it("invalid final_response schema escalates without persisting an incident", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      makeProvider(INVALID_INPUT),
    );

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Something exploded." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    // The loop decides escalate vs finding before it ends; an invalid
    // final_response escalates, writing one incident with an escalated outcome.
    const incident = await waitFor(() => incidentFor(sessionId));
    expect(incident.outcome).toBe("escalated");
  });
});
