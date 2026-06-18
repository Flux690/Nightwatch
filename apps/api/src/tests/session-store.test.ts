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
  listAllSessions,
  getSession,
  getSessionMessages,
} from "../db/sessions.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: randomUUID(),
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
  runnerId: "runner-A",
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
    expect(stored?.title).toBe("web-01 down");
    expect(stored?.originatingAlert).toEqual(alert);
  });

  it("stores a chat session with a null originating alert", () => {
    const m = meta({ title: "hello" });
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

  it("lists sessions newest first", () => {
    const older = meta({
      title: "older",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = meta({
      title: "newer",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const other = meta({ title: "other" });
    createSession(older, alert);
    createSession(newer, alert);
    createSession(other, alert);

    const list = listAllSessions().filter((session) =>
      [other.sessionId, newer.sessionId, older.sessionId].includes(
        session.sessionId,
      ),
    );
    expect(list.map((s) => s.title)).toEqual(["other", "newer", "older"]);
  });

  it("returns undefined for an unknown session", () => {
    expect(getSession("nope")).toBeUndefined();
    expect(getSessionMessages("nope")).toEqual([]);
  });
});
