import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type {
  NormalizedAlert,
  SessionDetail,
  SessionListPage,
} from "@nightwarden/shared";

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
import { dispatcher } from "../dispatcher.js";
import { getSession } from "../db/sessions.js";
import { hasReport } from "../db/reports.js";
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
        (e.payload["message"] as { kind?: string } | undefined)?.kind ===
          "assistant",
    );
  }

  // The id in a 202 has to name something the next request can fetch, whatever
  // work later moves ahead of the write.
  it("answers for the session id the moment it hands one out", async () => {
    setScript([{ text: "Working.", toolUses: [] }]);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Anything running?" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Deliberately no waitFor: needing one is the defect.
    const detail = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    expect(detail.status).toBe(200);
  });

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
    const { rows } = (await listRes.json()) as SessionListPage;
    expect(rows.some((s) => s.sessionId === sessionId)).toBe(true);

    const txRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    expect(txRes.status).toBe(200);
    const session = (await txRes.json()) as SessionDetail;
    // One user turn in, one agent turn back: the projection drops nothing.
    expect(session.transcript.map((i) => i.kind)).toEqual([
      "user_turn",
      "agent_text",
    ]);
  });

  // A bare transcript answered `200 []` for any id at all, so a deleted session
  // rendered as a real but empty one.
  it("answers 404 for a session that does not exist", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${randomUUID()}`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    expect(res.status).toBe(404);
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
    expect(stored?.alerts).toEqual([]);

    const txRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    const session = (await txRes.json()) as SessionDetail;
    // The session reports the same absence the row holds, so nothing downstream
    // has to infer it.
    expect(session.alerts).toEqual([]);
    expect(session.investigation).toBe(false);
    // The opening message is the human's verbatim - not a fabricated alert block.
    expect(session.transcript[0]).toMatchObject({
      kind: "user_turn",
      text: "Why did web-01 restart?",
    });
    expect(JSON.stringify(session.transcript[0])).not.toMatch(/<alert>/);
  });

  // An alert opens an investigation. The run below writes no report, so a
  // classification inferred from the leftovers would file this as a plain
  // conversation - which is the defect.
  it("classifies an alert-opened session as an investigation with no report written", async () => {
    setScript([{ text: "Looking into it.", toolUses: [] }]);
    const { events, close } = await connectConsoleEvents(port, SESSION);

    const sessionId = randomUUID();
    dispatcher.dispatch({
      sessionId,
      alerts: [
        {
          sourceAlertId: `si-${randomUUID()}`,
          labels: {},
          alertType: "ContainerDown",
          severity: "critical",
          firedAt: new Date().toISOString(),
          rawPayload: {},
        },
      ],
    });
    // The row carries the flag from the moment it exists - checked here, before
    // the run has produced a report to infer anything from.
    const created = await waitFor(() => getSession(sessionId));
    expect(created.investigation).toBe(true);
    expect(hasReport(sessionId)).toBe(false);

    await waitFor(() => hasAssistantMessage(events, sessionId));
    close();

    const detailRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    const session = (await detailRes.json()) as SessionDetail;
    expect(session.investigation).toBe(true);
    expect(session.alerts[0]?.alert.alertType).toBe("ContainerDown");

    const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { Cookie: `nw_auth=${SESSION}` },
    });
    const { rows } = (await listRes.json()) as SessionListPage;
    expect(rows.find((r) => r.sessionId === sessionId)?.investigation).toBe(
      true,
    );
  });

  describe("the session list pages rather than stopping", () => {
    async function listPage(query: string): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}/api/sessions${query}`, {
        headers: { Cookie: `nw_auth=${SESSION}` },
      });
    }

    it("serves a second page whose rows the first page did not carry", async () => {
      // Two sessions exist by now, which is enough to prove the offset moves.
      const first = (await (
        await listPage("?limit=1")
      ).json()) as SessionListPage;
      expect(first.rows).toHaveLength(1);
      expect(first.nextOffset).toBe(1);

      const second = (await (
        await listPage(`?limit=1&offset=${first.nextOffset}`)
      ).json()) as SessionListPage;
      expect(second.rows[0].sessionId).not.toBe(first.rows[0].sessionId);
    });

    it("rejects a limit that is not a page size", async () => {
      expect((await listPage("?limit=abc")).status).toBe(400);
      expect((await listPage("?limit=0")).status).toBe(400);
      expect((await listPage("?offset=-1")).status).toBe(400);
    });
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

    const { openingTurn } = buildInitialContext([alert]);
    expect(openingTurn).toContain("<alert>");
    expect(openingTurn).not.toContain("PAST INCIDENT HISTORY");
    expect(openingTurn).not.toContain("memory leak in image v12");
    expect(openingTurn).not.toContain("swap exhaustion under load");
  });
});
