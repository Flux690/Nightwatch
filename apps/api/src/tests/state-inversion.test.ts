import { randomUUID } from "node:crypto";
import { harness, type Harness } from "./harness.js";
import { dispatchAlertSession } from "./session-helper.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { waitFor } from "./wait.js";
import { registerFrontendEventRoutes } from "../session/events.js";
import {
  connectFrontendEvents,
  type FrontendEventFrame,
} from "./frontend-events-helper.js";

import { registerSessionRoutes } from "../session/routes.js";
import { getSession } from "../session/store.js";
import { getRecord } from "../session/record-store.js";
import { buildInitialContext } from "../agent/context.js";

describe("state inversion: persistence and reads are API-local", () => {
  let nw: Harness;
  let port: number;
  let SESSION: string;

  beforeAll(async () => {
    nw = await harness({
      routes: [registerFrontendEventRoutes, registerSessionRoutes],
    });
    ({ port } = nw);
    SESSION = nw.session;
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  function hasAssistantMessage(
    events: FrontendEventFrame[],
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
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({ message: "Anything running?" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Deliberately no waitFor: needing one is the defect.
    const detail = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `${SESSION}` } },
    );
    expect(detail.status).toBe(200);
  });

  it("lists sessions and reads the full transcript with no runner connected", async () => {
    setScript([{ text: "Looks healthy.", toolUses: [] }]);

    // Deliberately register no runner: the frontend must work during an outage.
    const { events, close } = await connectFrontendEvents(port, SESSION);

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

    await waitFor(() => hasAssistantMessage(events, sessionId));
    close();

    const listRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions?kind=chat`,
      { headers: { Cookie: `${SESSION}` } },
    );
    expect(listRes.status).toBe(200);
    const { rows } = (await listRes.json()) as SessionListPage;
    expect(rows.some((s) => s.sessionId === sessionId)).toBe(true);

    const txRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `${SESSION}` } },
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
      { headers: { Cookie: `${SESSION}` } },
    );
    expect(res.status).toBe(404);
  });

  it("opens a chat session with no synthetic alert (originating alert is null, opening message is the human's)", async () => {
    setScript([{ text: "Acknowledged.", toolUses: [] }]);

    const { events, close } = await connectFrontendEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({ message: "Why did web-01 restart?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };
    await waitFor(() => hasAssistantMessage(events, sessionId));
    close();

    const stored = await getSession(String(sessionId));
    // No originating alert is the chat-vs-alert distinction now (trigger is gone).
    expect(stored?.alerts).toEqual([]);

    const txRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `${SESSION}` } },
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

  // The run below writes no report, so a classification inferred from what it
  // left behind would file this investigation as a plain conversation.
  it("classifies an alert-opened session as an investigation with no report written", async () => {
    setScript([{ text: "Looking into it.", toolUses: [] }]);
    const { events, close } = await connectFrontendEvents(port, SESSION);

    const sessionId = randomUUID();
    await dispatchAlertSession(sessionId, [
      {
        sourceAlertId: `si-${randomUUID()}`,
        labels: {},
        alertType: "ContainerDown",
        firedAt: new Date().toISOString(),
        annotations: {},
        generatorURL: null,
        values: {},
      },
    ]);
    // The row carries the flag from the moment it exists - checked here, before
    // the run has produced a report to infer anything from.
    const created = await waitFor(async () => await getSession(sessionId));
    expect(created.investigation).toBe(true);
    expect(await getRecord(sessionId)).toBeUndefined();

    await waitFor(() => hasAssistantMessage(events, sessionId));
    close();

    const detailRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `${SESSION}` } },
    );
    const session = (await detailRes.json()) as SessionDetail;
    expect(session.investigation).toBe(true);
    expect(session.alerts[0]?.alert.alertType).toBe("ContainerDown");

    const listRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions?kind=investigation`,
      { headers: { Cookie: `${SESSION}` } },
    );
    const { rows } = (await listRes.json()) as SessionListPage;
    expect(rows.find((r) => r.sessionId === sessionId)?.investigation).toBe(
      true,
    );
  });

  describe("the session list pages rather than stopping", () => {
    async function listPage(query: string): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}/api/sessions?kind=chat&${query}`, {
        headers: { Cookie: `${SESSION}` },
      });
    }

    it("serves a second page whose rows the first page did not carry", async () => {
      // Two sessions exist by now, which is enough to prove the offset moves.
      const first = (await (
        await listPage("limit=1")
      ).json()) as SessionListPage;
      expect(first.rows).toHaveLength(1);
      expect(first.nextOffset).toBe(1);

      const second = (await (
        await listPage(`limit=1&offset=${first.nextOffset}`)
      ).json()) as SessionListPage;
      expect(second.rows[0].sessionId).not.toBe(first.rows[0].sessionId);
    });

    it("rejects a limit that is not a page size", async () => {
      expect((await listPage("limit=abc")).status).toBe(400);
      expect((await listPage("limit=0")).status).toBe(400);
      expect((await listPage("offset=-1")).status).toBe(400);
    });

    // The caller sent "abc", so naming NaN describes our own coercion rather
    // than what they got wrong.
    it("names the bound a bad limit missed, never the coercion behind it", async () => {
      const body = (await (await listPage("limit=abc")).json()) as {
        error: string;
      };
      expect(body.error).not.toMatch(/NaN/);
      expect(body.error).toMatch(/limit/i);
    });
  });
});

describe("state inversion: opening alert context stays alert-scoped", () => {
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
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
      firedAt: new Date().toISOString(),
      annotations: {},
      generatorURL: null,
      values: {},
    };

    const { openingTurn } = buildInitialContext([alert]);
    expect(openingTurn).toContain("<alert>");
    expect(openingTurn).not.toContain("PAST INCIDENT HISTORY");
    expect(openingTurn).not.toContain("memory leak in image v12");
    expect(openingTurn).not.toContain("swap exhaustion under load");
  });
});
