import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  NormalizedAlert,
  SessionMessage,
  SessionMeta,
} from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";

import {
  createSession,
  appendSessionMessages,
  appendMessagesAndInterrupt,
  listSessionSources,
  getSession,
  getSessionMessages,
  deleteSession,
} from "../db/sessions.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { getReport } from "../db/reports.js";
import { seedCompleteReport } from "./report-helper.js";
import { recordToolOutcome } from "../db/tool-outcomes.js";
import { buildTranscript } from "../session/transcript.js";
import {
  insertExecutingRemediationAction,
  findRemediationAction,
} from "../db/remediation-actions.js";

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
    parts: [{ type: "text", text: `message ${seq}` }],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const alert: NormalizedAlert = {
  sourceAlertId: "src-1",
  labels: {},
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
    expect(transcript[0].parts).toEqual([{ type: "text", text: "message 0" }]);
  });

  it("carries a tool call's outcome class into the rebuilt transcript", () => {
    // The provider message a reloaded transcript is rebuilt from has nowhere to
    // put our classification, so a reload would otherwise lose it.
    const m = meta();
    createSession(m, alert);
    appendSessionMessages([
      {
        ...msg(m.sessionId, 0, { role: "assistant" }),
        parts: [
          { type: "tool_call", id: "tu-miss", name: "Read", input: {} },
          { type: "tool_result", toolCallId: "tu-miss", output: "not found" },
        ],
      },
    ]);
    recordToolOutcome(m.sessionId, "tu-miss", "expected_miss");

    const card = buildTranscript(m.sessionId).find(
      (item) => item.kind === "tool_card",
    );
    expect(card?.state).toEqual({
      phase: "complete",
      result: "not found",
      outcome: "expected_miss",
    });
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

    const list = listSessionSources(100, 0).sources.filter((session) =>
      [other.sessionId, newer.sessionId, older.sessionId].includes(
        session.sessionId,
      ),
    );
    expect(list.map((s) => s.title)).toEqual(["other", "newer", "older"]);
  });

  describe("pagination", () => {
    // Distinct timestamps so the expected order is the one under test rather
    // than the id tiebreaker's.
    function seedSessions(count: number, prefix: string): void {
      for (let i = 0; i < count; i++) {
        createSession(
          meta({
            title: `${prefix}-${i}`,
            createdAt: `2026-03-01T00:00:${String(i).padStart(2, "0")}.000Z`,
          }),
          alert,
        );
      }
    }

    it("reaches sessions beyond the first page", () => {
      seedSessions(5, "page");

      const first = listSessionSources(2, 0);
      const second = listSessionSources(2, first.nextOffset ?? 0);

      expect(first.sources).toHaveLength(2);
      expect(first.nextOffset).toBe(2);
      expect(second.sources).toHaveLength(2);
      // No row is served on both pages, which is what the id tiebreaker buys.
      const ids = [...first.sources, ...second.sources].map((s) => s.sessionId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("reports no next offset on the last page", () => {
      const only = listSessionSources(1000, 0);
      expect(only.nextOffset).toBeNull();
    });

    it("floats a session awaiting human input above newer activity", () => {
      const waiting = meta({
        title: "waiting",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      createSession(waiting, alert);
      appendMessagesAndInterrupt([msg(waiting.sessionId, 0)], {
        sessionId: waiting.sessionId,
        toolUseId: "tu-float",
        kind: "approval",
        toolName: "RestartDockerService",
        toolInput: {},
        completedResults: [],
        claimedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      createSession(meta({ title: "newer than waiting" }), alert);

      const first = listSessionSources(1, 0);
      expect(first.sources[0].sessionId).toBe(waiting.sessionId);
      expect(first.sources[0].awaitingHumanInput).toBe(true);
    });
  });

  it("returns undefined for an unknown session", () => {
    expect(getSession("nope")).toBeUndefined();
    expect(getSessionMessages("nope")).toEqual([]);
  });

  it("deleteSession removes the session, its messages, and any pending interrupt", () => {
    const m = meta();
    createSession(m, alert);
    appendMessagesAndInterrupt([msg(m.sessionId, 0)], {
      sessionId: m.sessionId,
      toolUseId: "tu-del-1",
      kind: "approval",
      toolName: "RestartDockerService",
      toolInput: {},
      completedResults: [],
      claimedAt: null,
      createdAt: new Date().toISOString(),
    });

    deleteSession(m.sessionId);

    expect(getSession(m.sessionId)).toBeUndefined();
    expect(getSessionMessages(m.sessionId)).toEqual([]);
    expect(hasPendingHumanInput(m.sessionId)).toBe(false);
  });

  it("deleteSession on an unknown session is a no-op", () => {
    expect(() => deleteSession("nope")).not.toThrow();
  });

  it("deleteSession removes the report (it has no reason to outlive the session)", () => {
    const m = meta();
    createSession(m, alert);
    seedCompleteReport(m.sessionId);
    expect(getReport(m.sessionId)).toBeDefined();

    deleteSession(m.sessionId);

    expect(getReport(m.sessionId)).toBeUndefined();
  });

  it("deleteSession preserves the remediation audit log (the record outlives the session)", () => {
    const m = meta();
    createSession(m, alert);
    insertExecutingRemediationAction({
      toolUseId: "tu-audit-survives",
      sessionId: m.sessionId,
      toolName: "RestartDockerService",
      input: {
        target: "docker/web/web",
      },
      resolvedBy: "console",
    });

    deleteSession(m.sessionId);

    expect(getSession(m.sessionId)).toBeUndefined();
    expect(
      findRemediationAction(m.sessionId, "tu-audit-survives"),
    ).toBeDefined();
  });

  it("rejects a transcript message for a session that does not exist (foreign keys enforced)", () => {
    expect(() => appendSessionMessages([msg("ghost-session", 0)])).toThrow(
      /FOREIGN KEY/i,
    );
  });
});
