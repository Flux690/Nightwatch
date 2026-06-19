import "dotenv/config";
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
const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import {
  createScriptRunner,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

const scriptRunner = createScriptRunner();
mockCreateProvider.mockImplementation(() => scriptRunner.create());
const setScript = (turns: ScriptedTurn[]): void =>
  scriptRunner.setScript(turns);

import { generateToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerChatRoutes } from "../chat/routes.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import { getSession } from "../db/sessions.js";
import { buildInitialContext } from "../investigation/context.js";
import {
  registerRunner,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";

interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
}

describe("state inversion: persistence and reads are API-local", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let TEST_TOKEN: string;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = generateToken("state-inversion").id;

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
    setScript([{ text: "Looks healthy.", toolUses: [] }]);

    // Deliberately register no runner: the console must work during an outage.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events = collectEvents(ws);
    await waitForConnected(ws);

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

    await waitFor(() => hasAssistantRunFinished(events, sessionId));
    ws.close();

    const listRes = await fetch(`http://127.0.0.1:${port}/sessions`, {
      headers: { Cookie: `nw_auth=${SESSION}` },
    });
    expect(listRes.status).toBe(200);
    const sessions = (await listRes.json()) as Array<{ sessionId: string }>;
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);

    const txRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
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
    setScript([{ text: "Acknowledged.", toolUses: [] }]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events = collectEvents(ws);
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Why did web-01 restart?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await waitFor(() => hasAssistantRunFinished(events, sessionId));
    ws.close();

    const stored = getSession(String(sessionId));
    // No originating alert is the chat-vs-alert distinction now (trigger is gone).
    expect(stored?.originatingAlert).toBeNull();

    const txRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
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

  it("returns 401 on /sessions and /sessions/:id without a valid nw_auth cookie", async () => {
    const listRes = await fetch(`http://127.0.0.1:${port}/sessions`);
    expect(listRes.status).toBe(401);

    const txRes = await fetch(
      `http://127.0.0.1:${port}/sessions/nonexistent-id`,
    );
    expect(txRes.status).toBe(401);
  });
});

describe("state inversion: opening alert context stays alert-scoped", () => {
  let cleanupDb: () => void;

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("does not inject past incident history into the opening alert context", async () => {
    const alert: NormalizedAlert = {
      sourceAlertId: "src-9",
      runnerId: "runner-history",
      targetIdentifier: "web-01",
      alertType: "HighMemory",
      severity: "warning",
      firedAt: new Date().toISOString(),
      rawPayload: {},
    };

    const { firstUserMessage } = buildInitialContext([alert]);
    expect(firstUserMessage).toContain("INCIDENT ALERT");
    expect(firstUserMessage).not.toContain("PAST INCIDENT HISTORY");
    expect(firstUserMessage).not.toContain("memory leak in image v12");
    expect(firstUserMessage).not.toContain("swap exhaustion under load");
  });
});
