import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  NormalizedAlert,
  SessionMessage,
  SessionMeta,
} from "@nightwatch/shared";
import { useTempDb } from "./temp-db.js";

import {
  createSession,
  appendSessionMessages,
  listSessions,
  getSession,
  getSessionMessages,
} from "../db/sessions.js";
import {
  insertIncident,
  getRecentIncidents,
  getIncidentById,
  updateResolutionNote,
} from "../db/incidents.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: randomUUID(),
    token: "tok-A",
    trigger: "alert",
    title: "web-01 down",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function msg(
  sessionId: string,
  seq: number,
  overrides: Partial<SessionMessage> = {},
): SessionMessage {
  return {
    sessionId,
    seq,
    role: seq % 2 === 0 ? "user" : "assistant",
    content: `message ${seq}`,
    providerContent: { block: seq },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const alert: NormalizedAlert = {
  sourceAlertId: "src-1",
  token: "tok-A",
  targetIdentifier: "web-01",
  alertType: "ContainerDown",
  severity: "critical",
  firedAt: "2026-06-13T00:00:00.000Z",
  rawPayload: { foo: "bar" },
};

describe("API-local session store", () => {
  let cleanupDb: () => void;

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("round-trips a session with its originating alert", () => {
    const m = meta();
    createSession(m, alert);

    const stored = getSession(m.sessionId);
    expect(stored).toBeDefined();
    expect(stored?.token).toBe("tok-A");
    expect(stored?.trigger).toBe("alert");
    expect(stored?.title).toBe("web-01 down");
    expect(stored?.originatingAlert).toEqual(alert);
  });

  it("stores a chat session with a null originating alert", () => {
    const m = meta({ trigger: "chat", title: "hello" });
    createSession(m, null);

    expect(getSession(m.sessionId)?.originatingAlert).toBeNull();
  });

  it("createSession is idempotent and never clobbers the first title", () => {
    const m = meta({ title: "first" });
    createSession(m, alert);
    createSession({ ...m, title: "second" }, null);

    const stored = getSession(m.sessionId);
    expect(stored?.title).toBe("first");
    expect(stored?.originatingAlert).toEqual(alert);
  });

  it("persists and reads back a transcript ordered by seq", () => {
    const m = meta();
    createSession(m, alert);
    // Insert out of order to prove ordering is by seq, not insertion.
    appendSessionMessages([msg(m.sessionId, 1), msg(m.sessionId, 0)]);
    appendSessionMessages([msg(m.sessionId, 2)]);

    const transcript = getSessionMessages(m.sessionId);
    expect(transcript.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(transcript[0].role).toBe("user");
    expect(transcript[1].role).toBe("assistant");
    expect(transcript[0].providerContent).toEqual({ block: 0 });
  });

  it("rejects a duplicate (session_id, seq) so a hole can never be re-filled", () => {
    const m = meta();
    createSession(m, alert);
    appendSessionMessages([msg(m.sessionId, 0)]);

    expect(() => appendSessionMessages([msg(m.sessionId, 0)])).toThrow();
  });

  it("appends a batch atomically: a duplicate in the batch rolls back the whole turn", () => {
    const m = meta();
    createSession(m, alert);
    appendSessionMessages([msg(m.sessionId, 0)]);

    // seq 1 is new, seq 0 collides; the batch must be all-or-nothing.
    expect(() =>
      appendSessionMessages([msg(m.sessionId, 1), msg(m.sessionId, 0)]),
    ).toThrow();
    expect(getSessionMessages(m.sessionId).map((t) => t.seq)).toEqual([0]);
  });

  it("lists sessions for a token, newest first, scoped to that token", () => {
    const token = `tok-${randomUUID()}`;
    const older = meta({
      token,
      title: "older",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = meta({
      token,
      title: "newer",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const other = meta({ token: "tok-other", title: "other" });
    createSession(older, alert);
    createSession(newer, alert);
    createSession(other, alert);

    const list = listSessions(token);
    expect(list.map((s) => s.title)).toEqual(["newer", "older"]);
    expect(list.every((s) => s.token === token)).toBe(true);
  });

  it("returns undefined for an unknown session", () => {
    expect(getSession("nope")).toBeUndefined();
    expect(getSessionMessages("nope")).toEqual([]);
  });
});

describe("API-local incident store", () => {
  let cleanupDb: () => void;

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  function incident(
    token: string,
    overrides: Partial<Parameters<typeof insertIncident>[1]> = {},
  ): Parameters<typeof insertIncident>[1] {
    return {
      incidentId: randomUUID(),
      sessionId: randomUUID(),
      outcome: "finding",
      timestamp: new Date().toISOString(),
      containerName: "web-01",
      alertType: "ContainerDown",
      rootCause: "wedged process table",
      resolutionAction: "restart_container",
      resolvedAt: null,
      recurrenceCount: 0,
      ...overrides,
    };
  }

  it("scopes recent incidents to the token (no cross-deployment leakage)", () => {
    insertIncident("tok-1", incident("tok-1", { rootCause: "mine" }));
    insertIncident("tok-2", incident("tok-2", { rootCause: "theirs" }));

    const mine = getRecentIncidents("tok-1");
    expect(mine).toHaveLength(1);
    expect(mine[0].rootCause).toBe("mine");
  });

  it("filters by container and alert type within the token", () => {
    const token = `tok-${randomUUID()}`;
    insertIncident(
      token,
      incident(token, { containerName: "web-01", alertType: "ContainerDown" }),
    );
    insertIncident(
      token,
      incident(token, { containerName: "db-01", alertType: "HighMemory" }),
    );

    expect(getRecentIncidents(token, "web-01")).toHaveLength(1);
    expect(getRecentIncidents(token, "web-01", "ContainerDown")).toHaveLength(
      1,
    );
    expect(getRecentIncidents(token, "web-01", "HighMemory")).toHaveLength(0);
  });

  it("excludes incidents older than the lookback window", () => {
    const token = `tok-${randomUUID()}`;
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    insertIncident(
      token,
      incident(token, { timestamp: old, rootCause: "ancient" }),
    );
    insertIncident(token, incident(token, { rootCause: "recent" }));

    const within30 = getRecentIncidents(token, undefined, undefined, 30);
    expect(within30.map((i) => i.rootCause)).toEqual(["recent"]);
  });

  it("round-trips a resolution note onto an escalated incident", () => {
    const token = `tok-${randomUUID()}`;
    const rec = incident(token, { outcome: "escalated" });
    insertIncident(token, rec);

    updateResolutionNote(rec.incidentId, "rotated the credentials");

    expect(getIncidentById(rec.incidentId)?.humanResolutionNote).toBe(
      "rotated the credentials",
    );
  });
});
