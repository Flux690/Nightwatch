import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { NormalizedAlert, RunnerCommandMessage } from "@nightwatch/shared";

// A stateful provider: snapshot() reflects everything accumulated, so the loop's
// per-turn persistence writes real transcript rows. The script is supplied per
// test via the hoisted setter.
const { mockCreateProvider, setScript } = vi.hoisted(() => {
  type ProvMsg = {
    role: "user" | "assistant";
    content: string;
    providerContent: unknown;
  };
  type Turn = {
    text: string;
    toolUses: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;
  };
  let script: Turn[] = [];
  let scriptIndex = 0;

  const makeProvider = () => {
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
          const turn = script[scriptIndex++] ?? script[script.length - 1];
          onDelta?.({ kind: "text", text: turn.text });
          messages.push({
            role: "assistant",
            content: turn.text,
            providerContent: {},
          });
          return Promise.resolve({
            stopReason: "tool_use" as const,
            toolUses: turn.toolUses,
            text: turn.text,
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
    setScript: (turns: Turn[]) => {
      script = turns;
      scriptIndex = 0;
    },
  };
});

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import { mintToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerChatRoutes } from "../chat/routes.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import { insertIncident } from "../db/incidents.js";
import { getSession } from "../db/sessions.js";
import { buildInitialContext } from "../investigation/context.js";
import {
  registerRunner,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";

const FINAL_RESPONSE = {
  id: "fr-1",
  name: "final_response",
  input: {
    rootCause: {
      summary: "All clear.",
      evidence: ["nothing on fire"],
      contributingFactors: null,
    },
    recommendedAction: null,
    escalateIfRejected: false,
    investigationSteps: ["looked around"],
  },
};

interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
}

describe("state inversion: persistence and reads are API-local", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let TEST_TOKEN: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    TEST_TOKEN = mintToken("state-inversion").id;

    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerConsoleWsRoutes(server);
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

  // Resolve once the console handler has acked its subscription; a fast publish
  // (e.g. a platform tool's TOOL_CALL_END) otherwise races ahead of the
  // event-bus subscribe and is missed.
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

  // Buffer every event from the socket. The run resolves in microtasks now, so
  // an assistant RUN_FINISHED can be published before the test has captured the
  // session id it is keyed by; buffering lets the assertion poll for it after.
  function collectEvents(ws: WebSocket): WsEvent[] {
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    return events;
  }

  function hasAssistantRunFinished(
    events: WsEvent[],
    sessionId: string,
  ): boolean {
    return events.some(
      (e) =>
        e.type === "RUN_FINISHED" &&
        e.payload["sessionId"] === sessionId &&
        (e.payload["message"] as { role?: string } | undefined)?.role ===
          "assistant",
    );
  }

  it("lists sessions and reads the full transcript with no runner connected", async () => {
    setScript([{ text: "Looks healthy.", toolUses: [FINAL_RESPONSE] }]);

    // Deliberately register no runner: the console must work during an outage.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events = collectEvents(ws);
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Is the system healthy?" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() => hasAssistantRunFinished(events, sessionId));
    ws.close();

    const listRes = await fetch(
      `http://127.0.0.1:${port}/sessions?token=${TEST_TOKEN}`,
    );
    expect(listRes.status).toBe(200);
    const sessions = (await listRes.json()) as Array<{ sessionId: string }>;
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);

    const txRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}?token=${TEST_TOKEN}`,
    );
    expect(txRes.status).toBe(200);
    const transcript = (await txRes.json()) as Array<{
      role: string;
      content: string;
      seq: number;
    }>;
    expect(transcript.length).toBeGreaterThanOrEqual(2);
    expect(transcript.map((m) => m.seq)).toEqual([0, 1]);
  });

  it("opens a chat session with no synthetic alert (originating alert is null, opening message is the human's)", async () => {
    setScript([{ text: "Acknowledged.", toolUses: [FINAL_RESPONSE] }]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events = collectEvents(ws);
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Why did web-01 restart?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await waitFor(() => hasAssistantRunFinished(events, sessionId));
    ws.close();

    const stored = getSession(String(sessionId));
    expect(stored?.trigger).toBe("chat");
    expect(stored?.originatingAlert).toBeNull();

    const txRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}?token=${TEST_TOKEN}`,
    );
    const transcript = (await txRes.json()) as Array<{
      role: string;
      content: string;
    }>;
    // The opening message is the human's verbatim - not a fabricated INCIDENT
    // ALERT block.
    expect(transcript[0]).toMatchObject({
      role: "user",
      content: "Why did web-01 restart?",
    });
    expect(transcript[0].content).not.toMatch(/INCIDENT ALERT/);
  });

  it("serves get_incident_history from the API store without routing to a runner", async () => {
    // A runner that fails everything: if get_incident_history were still a runner
    // tool, the result would be an error - proving it is now platform-handled.
    const RUNNER_ID = "hostile-runner";
    registerRunner(
      TEST_TOKEN,
      RUNNER_ID,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: false,
          result: null,
          error: "runner should not have been called",
        });
      },
      () => {},
    );

    insertIncident(TEST_TOKEN, {
      incidentId: randomUUID(),
      sessionId: randomUUID(),
      outcome: "finding",
      timestamp: new Date().toISOString(),
      containerName: "api-01",
      alertType: "ContainerDown",
      rootCause: "ran out of file descriptors",
      resolutionAction: "restart_container",
      resolvedAt: null,
      recurrenceCount: 0,
    });

    setScript([
      {
        text: "Checking history.",
        toolUses: [
          {
            id: "hist-1",
            name: "get_incident_history",
            input: { containerName: "api-01" },
          },
        ],
      },
      { text: "Done.", toolUses: [FINAL_RESPONSE] },
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    await waitForConnected(ws);

    let sessionId: string | undefined;
    let resolveHist!: (e: WsEvent) => void;
    const histEnd = new Promise<WsEvent>((res, rej) => {
      resolveHist = res;
      setTimeout(
        () => rej(new Error("timeout: no get_incident_history end")),
        10_000,
      );
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as WsEvent;
      if (
        msg.type === "TOOL_CALL_END" &&
        msg.payload["toolUseId"] === "hist-1"
      ) {
        resolveHist(msg);
      }
    });

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Has api-01 failed before?" }),
    });
    ({ sessionId } = (await res.json()) as { sessionId: string });
    expect(typeof sessionId).toBe("string");

    const end = await histEnd;
    ws.close();
    unregisterRunner(TEST_TOKEN, RUNNER_ID);

    expect(end.payload["isError"]).toBeFalsy();
    expect(String(end.payload["result"])).toContain(
      "ran out of file descriptors",
    );
  });
});

describe("state inversion: episodic memory loads from the central store", () => {
  let cleanupDb: () => void;
  const TOKEN = `tok-${randomUUID()}`;

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("injects past incidents for the deployment regardless of which runner recorded them", async () => {
    // Two incidents for the same deployment + container, as if recorded by
    // different runners across time - all in one central store.
    insertIncident(TOKEN, {
      incidentId: randomUUID(),
      sessionId: randomUUID(),
      outcome: "finding",
      timestamp: new Date(Date.now() - 86_400_000).toISOString(),
      containerName: "web-01",
      alertType: "HighMemory",
      rootCause: "memory leak in image v12",
      resolutionAction: "rollback_deploy",
      resolvedAt: null,
      recurrenceCount: 0,
    });
    insertIncident(TOKEN, {
      incidentId: randomUUID(),
      sessionId: randomUUID(),
      outcome: "escalated",
      timestamp: new Date().toISOString(),
      containerName: "web-01",
      alertType: "HighMemory",
      rootCause: "swap exhaustion under load",
      resolutionAction: null,
      resolvedAt: null,
      recurrenceCount: 0,
    });

    const alert: NormalizedAlert = {
      sourceAlertId: "src-9",
      token: TOKEN,
      targetIdentifier: "web-01",
      alertType: "HighMemory",
      severity: "warning",
      firedAt: new Date().toISOString(),
      rawPayload: {},
    };

    const { firstUserMessage } = buildInitialContext(alert);
    expect(firstUserMessage).toContain("memory leak in image v12");
    expect(firstUserMessage).toContain("swap exhaustion under load");
  });

  it("never puts the deployment token in the opening context (it is a secret)", () => {
    const secret = `nwr_${randomUUID()}-supersecret`;
    const alert: NormalizedAlert = {
      sourceAlertId: "src-token",
      token: secret,
      targetIdentifier: "web-01",
      alertType: "HighCPU",
      severity: "warning",
      firedAt: new Date().toISOString(),
      rawPayload: {},
    };

    // The token authenticates the alert and keys incident history, but the LLM
    // never needs it - and the opening message is sent to an external provider.
    const { firstUserMessage } = buildInitialContext(alert);
    expect(firstUserMessage).not.toContain(secret);
  });

  it("does not leak another deployment's incidents into the opening context", async () => {
    insertIncident("tok-stranger", {
      incidentId: randomUUID(),
      sessionId: randomUUID(),
      outcome: "finding",
      timestamp: new Date().toISOString(),
      containerName: "web-01",
      alertType: "HighMemory",
      rootCause: "stranger's secret incident",
      resolutionAction: null,
      resolvedAt: null,
      recurrenceCount: 0,
    });

    const alert: NormalizedAlert = {
      sourceAlertId: "src-10",
      token: `tok-empty-${randomUUID()}`,
      targetIdentifier: "web-01",
      alertType: "HighMemory",
      severity: "warning",
      firedAt: new Date().toISOString(),
      rawPayload: {},
    };

    const { firstUserMessage } = buildInitialContext(alert);
    expect(firstUserMessage).not.toContain("stranger's secret incident");
    expect(firstUserMessage).toContain("(no past incidents)");
  });
});
