import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { NormalizedAlert, TranscriptItem } from "@nightwarden/shared";

// A stateful provider: snapshot() reflects everything accumulated, so the loop's
// per-turn persistence writes real transcript rows.
vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import {
  createScriptRunner,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

const scriptRunner = createScriptRunner();
mockCreateProvider.mockImplementation(() => scriptRunner.create());
const setScript = (turns: ScriptedTurn[]): void =>
  scriptRunner.setScript(turns);

import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { registerConsoleEventRoutes } from "../session/events.js";
import {
  connectConsoleEvents,
  type ConsoleEventFrame,
} from "./console-events-helper.js";

import { registerSessionRoutes } from "../session/routes.js";
import { getSession } from "../db/sessions.js";
import { buildInitialContext } from "../agent/context.js";
import { mountApi } from "./api-server.js";

describe("state inversion: persistence and reads are API-local", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();

    server = Fastify({ logger: false, forceCloseConnections: true });
    await mountApi(server, registerConsoleEventRoutes);
    await mountApi(server, registerSessionRoutes);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  function hasAssistantMessage(
    events: ConsoleEventFrame[],
    sessionId: string,
  ): boolean {
    return events.some(
      (e) =>
        e.type === "MESSAGE" &&
        e.payload["sessionId"] === sessionId &&
        (e.payload["message"] as { role?: string } | undefined)?.role ===
          "assistant",
    );
  }

  it("lists sessions and reads the full transcript with no runner connected", async () => {
    setScript([{ text: "Looks healthy.", toolUses: [] }]);

    // Deliberately register no runner: the console must work during an outage.
    const { events, close } = await connectConsoleEvents(port, SESSION);

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

    await waitFor(() => hasAssistantMessage(events, sessionId));
    close();

    const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { Cookie: `nw_auth=${SESSION}` },
    });
    expect(listRes.status).toBe(200);
    const sessions = (await listRes.json()) as Array<{ sessionId: string }>;
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);

    const txRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    expect(txRes.status).toBe(200);
    const items = (await txRes.json()) as TranscriptItem[];
    // One user turn in, one agent turn back: the projection drops nothing.
    expect(items.map((i) => i.kind)).toEqual(["user_turn", "agent_text"]);
  });

  it("opens a chat session with no synthetic alert (originating alert is null, opening message is the human's)", async () => {
    setScript([{ text: "Acknowledged.", toolUses: [] }]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Why did web-01 restart?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await waitFor(() => hasAssistantMessage(events, sessionId));
    close();

    const stored = getSession(String(sessionId));
    // No originating alert is the chat-vs-alert distinction now (trigger is gone).
    expect(stored?.originatingAlert).toBeNull();

    const txRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    const items = (await txRes.json()) as TranscriptItem[];
    // The opening message is the human's verbatim - not a fabricated INCIDENT
    // ALERT block.
    expect(items[0]).toMatchObject({
      kind: "user_turn",
      text: "Why did web-01 restart?",
    });
    expect(JSON.stringify(items[0])).not.toMatch(/INCIDENT ALERT/);
  });

  it("keeps a stopped investigation classified as one", async () => {
    setScript([{ text: "Looking into it.", toolUses: [] }]);
    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({
        message: "Look into web-01",
        mode: "investigate",
      }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await waitFor(() => hasAssistantMessage(events, sessionId));
    close();

    // Stopping before the agent writes a report used to file the session as a
    // conversation, because the classification was inferred from its leftovers.
    const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { Cookie: `nw_auth=${SESSION}` },
    });
    const rows = (await listRes.json()) as Array<{
      sessionId: string;
      investigation: boolean;
    }>;
    expect(rows.find((r) => r.sessionId === sessionId)?.investigation).toBe(
      true,
    );
  });

  it("returns 401 on /sessions and /sessions/:id without a valid nw_auth cookie", async () => {
    const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(listRes.status).toBe(401);

    const txRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/nonexistent-id`,
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
      labels: {},
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
