import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  NormalizedAlert,
  TranscriptRow,
  SessionMeta,
} from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";

import {
  createSession,
  appendSessionAlert,
  appendTranscriptRows,
  appendRowsAndInterrupt,
  listSessionSources,
  getSession,
  getTranscriptRows,
  deleteSession,
  markAlertCleared,
} from "../db/sessions.js";
import { listSessionPage } from "../session/list.js";
import {
  proposeFix,
  proposeHypothesis,
  resolveHypothesis,
} from "../agent/report.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { getReport } from "../db/reports.js";
import { seedCompleteReport } from "./report-helper.js";
import { recordToolOutcome } from "../db/tool-outcomes.js";
import { buildSeed } from "../session/seed.js";
import { buildTranscript } from "../session/transcript.js";
import {
  insertExecutingRemediationAction,
  findRemediationAction,
  settleRemediationAction,
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
  overrides: Partial<TranscriptRow> = {},
): TranscriptRow {
  return {
    sessionId,
    seq,
    kind: seq % 2 === 0 ? "user" : "assistant",
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

  it("round-trips a session with the alert that opened it", () => {
    const m = meta();
    createSession(m, [alert]);

    const stored = getSession(m.sessionId);
    expect(stored).toBeDefined();
    expect(stored?.title).toBe("web-01 down");
    expect(stored?.alerts).toEqual([
      { alert, arrivedAt: m.createdAt, clearedAt: null },
    ]);
  });

  it("stores a chat session with no alerts at all", () => {
    const m = meta({ title: "hello" });
    createSession(m, []);

    expect(getSession(m.sessionId)?.alerts).toEqual([]);
  });

  it("keeps an alert that arrived after the session was already running", () => {
    const m = meta();
    const later = {
      ...alert,
      sourceAlertId: "later",
      alertType: "HighLatency",
    };
    createSession(m, [alert]);
    appendSessionAlert(m.sessionId, later);

    const stored = getSession(m.sessionId)!.alerts;
    expect(stored.map((entry) => entry.alert)).toEqual([alert, later]);
    // The opening batch shares the session's instant; a later arrival carries
    // its own, which is what places it at the turn it interrupted. Two clock
    // reads can tie, so this asserts it is stamped, not that time moved.
    expect(stored[0]!.arrivedAt).toBe(m.createdAt);
    expect(stored[1]!.arrivedAt >= m.createdAt).toBe(true);
    expect(stored[1]!.clearedAt).toBeNull();
  });

  it("createSession is idempotent and never clobbers the first title", () => {
    const m = meta({ title: "first" });
    createSession(m, [alert]);
    createSession({ ...m, title: "second" }, []);

    const stored = getSession(m.sessionId);
    expect(stored?.title).toBe("first");
    expect(stored?.alerts.map((entry) => entry.alert)).toEqual([alert]);
  });

  it("persists and reads back a transcript ordered by seq", () => {
    const m = meta();
    createSession(m, [alert]);
    // Insert out of order to prove ordering is by seq, not insertion.
    appendTranscriptRows([msg(m.sessionId, 1), msg(m.sessionId, 0)]);
    appendTranscriptRows([msg(m.sessionId, 2)]);

    const transcript = getTranscriptRows(m.sessionId);
    expect(transcript.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(transcript[0].kind).toBe("user");
    expect(transcript[1].kind).toBe("assistant");
    expect(transcript[0].parts).toEqual([{ type: "text", text: "message 0" }]);
  });

  it("replays a harness message to the model and draws it for nobody", () => {
    // The operator did not write it, so the transcript must not show it as
    // theirs; the model answered it, so a resume that dropped it would leave
    // that answer replying to nothing.
    const m = meta();
    createSession(m, [alert]);
    appendTranscriptRows([
      msg(m.sessionId, 0),
      msg(m.sessionId, 1),
      msg(m.sessionId, 2, {
        kind: "nightwarden",
        content: "Your investigation record is not finished.",
        parts: [
          { type: "text", text: "Your investigation record is not finished." },
        ],
      }),
      msg(m.sessionId, 3),
    ]);

    const drawn = JSON.stringify(buildTranscript(m.sessionId));
    expect(drawn).not.toContain("Your investigation record");
    expect(buildTranscript(m.sessionId)).toHaveLength(3);

    // The seed speaks the provider's vocabulary, where there are two roles and
    // "nightwarden" is not one of them: it goes back as the user turn it was.
    const seeded = buildSeed(m.sessionId);
    expect(seeded).toHaveLength(4);
    expect(seeded[2]).toMatchObject({
      role: "user",
      content: "Your investigation record is not finished.",
    });
  });

  it("carries a tool call's outcome class into the rebuilt transcript", () => {
    // The provider message a reloaded transcript is rebuilt from has nowhere to
    // put our classification, so a reload would otherwise lose it.
    const m = meta();
    createSession(m, [alert]);
    appendTranscriptRows([
      {
        ...msg(m.sessionId, 0, { kind: "assistant" }),
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
    createSession(m, [alert]);
    appendTranscriptRows([msg(m.sessionId, 0)]);

    expect(() => appendTranscriptRows([msg(m.sessionId, 0)])).toThrow();
  });

  it("appends a batch atomically: a duplicate in the batch rolls back the whole turn", () => {
    const m = meta();
    createSession(m, [alert]);
    appendTranscriptRows([msg(m.sessionId, 0)]);

    // seq 1 is new, seq 0 collides; the batch must be all-or-nothing.
    expect(() =>
      appendTranscriptRows([msg(m.sessionId, 1), msg(m.sessionId, 0)]),
    ).toThrow();
    expect(getTranscriptRows(m.sessionId).map((t) => t.seq)).toEqual([0]);
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
    createSession(older, [alert]);
    createSession(newer, [alert]);
    createSession(other, [alert]);

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
          [alert],
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
      createSession(waiting, [alert]);
      appendRowsAndInterrupt([msg(waiting.sessionId, 0)], {
        sessionId: waiting.sessionId,
        toolUseId: "tu-float",
        kind: "approval",
        completedResults: [],
        claimedAt: null,
      });
      createSession(meta({ title: "newer than waiting" }), [alert]);

      const first = listSessionSources(1, 0);
      expect(first.sources[0].sessionId).toBe(waiting.sessionId);
      expect(first.sources[0].awaitingHumanInput).toBe(true);
    });
  });

  it("returns undefined for an unknown session", () => {
    expect(getSession("nope")).toBeUndefined();
    expect(getTranscriptRows("nope")).toEqual([]);
  });

  it("deleteSession removes the session, its messages, and any pending interrupt", () => {
    const m = meta();
    createSession(m, [alert]);
    appendRowsAndInterrupt([msg(m.sessionId, 0)], {
      sessionId: m.sessionId,
      toolUseId: "tu-del-1",
      kind: "approval",
      completedResults: [],
      claimedAt: null,
    });

    deleteSession(m.sessionId);

    expect(getSession(m.sessionId)).toBeUndefined();
    expect(getTranscriptRows(m.sessionId)).toEqual([]);
    expect(hasPendingHumanInput(m.sessionId)).toBe(false);
  });

  it("deleteSession on an unknown session is a no-op", () => {
    expect(() => deleteSession("nope")).not.toThrow();
  });

  it("deleteSession removes the report (it has no reason to outlive the session)", () => {
    const m = meta();
    createSession(m, [alert]);
    seedCompleteReport(m.sessionId);
    expect(getReport(m.sessionId)).toBeDefined();

    deleteSession(m.sessionId);

    expect(getReport(m.sessionId)).toBeUndefined();
  });

  it("deleteSession preserves the remediation audit log (the record outlives the session)", () => {
    const m = meta();
    createSession(m, [alert]);
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
    expect(() => appendTranscriptRows([msg("ghost-session", 0)])).toThrow(
      /FOREIGN KEY/i,
    );
  });

  // The five words and nothing else. Every one of them is derived from the
  // action log, the alert or the hypothesis rows; none is ever declared.
  describe("derived status", () => {
    function statusOf(sessionId: string): string | null {
      const row = listSessionPage(200, 0).rows.find(
        (r) => r.sessionId === sessionId,
      );
      return row?.status ?? null;
    }

    // Its own alert id per session: clearing one must not settle another's.
    function investigation(sourceAlertId = randomUUID()): string {
      const m = meta();
      createSession(m, [{ ...alert, sourceAlertId }], true);
      return m.sessionId;
    }

    it("says nothing about a session that is not under investigation", () => {
      const m = meta();
      createSession(m, []);
      expect(statusOf(m.sessionId)).toBeNull();
    });

    it("reads Resolved once a remediation executed", () => {
      const sessionId = investigation();
      seedCompleteReport(sessionId);
      insertExecutingRemediationAction({
        toolUseId: "tu-exec",
        sessionId,
        toolName: "RestartDockerService",
        input: { target: "docker/app/web" },
        resolvedBy: "operator",
      });
      expect(statusOf(sessionId)).toBe("inconclusive");
      settleRemediationAction(sessionId, "tu-exec", "executed", "ok");
      expect(statusOf(sessionId)).toBe("resolved");
    });

    it("reads Resolved when the alert cleared, with nothing run", () => {
      const sourceAlertId = randomUUID();
      const sessionId = investigation(sourceAlertId);
      const untouched = investigation();
      seedCompleteReport(sessionId);
      seedCompleteReport(untouched);
      expect(statusOf(sessionId)).toBe("inconclusive");

      markAlertCleared(sourceAlertId, new Date().toISOString());
      expect(statusOf(sessionId)).toBe("resolved");
      expect(statusOf(untouched)).toBe("inconclusive");
    });

    it("stays unresolved until every alert of a batch has cleared", () => {
      // A batch elects no primary, so one symptom recovering while the others
      // still fire is not the incident being over.
      const m = meta();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      createSession(
        m,
        ids.map((sourceAlertId) => ({ ...alert, sourceAlertId })),
        true,
      );
      seedCompleteReport(m.sessionId);

      markAlertCleared(ids[0]!, new Date().toISOString());
      expect(statusOf(m.sessionId)).toBe("inconclusive");
      markAlertCleared(ids[1]!, new Date().toISOString());
      expect(statusOf(m.sessionId)).toBe("inconclusive");

      markAlertCleared(ids[2]!, new Date().toISOString());
      expect(statusOf(m.sessionId)).toBe("resolved");
    });

    it("reads Action required for a finished run whose fix nobody acted on", () => {
      const sessionId = investigation();
      seedCompleteReport(sessionId);
      proposeFix(sessionId, "restart the container", []);
      expect(statusOf(sessionId)).toBe("action_required");
    });

    it("reads Failed when the run crashed rather than stood down", () => {
      const sessionId = investigation();
      appendTranscriptRows([msg(sessionId, 0, { kind: "error" })]);
      expect(statusOf(sessionId)).toBe("failed");
    });

    it("reads Inconclusive when the record holds no cause it could stand behind", () => {
      const settled = investigation();
      seedCompleteReport(settled);
      expect(statusOf(settled)).toBe("inconclusive");

      // Recording nothing at all is the same answer, honestly stated.
      expect(statusOf(investigation())).toBe("inconclusive");
    });

    it("says nothing when a cause was found but nothing was recommended or run", () => {
      const sessionId = investigation();
      proposeHypothesis(sessionId, "the deploy set the cache size");
      resolveHypothesis(sessionId, {
        id: "h1",
        verdict: "trigger",
        finding: "the climb starts at the merge",
        evidenceIds: ["tu-never-ran"],
      });
      expect(statusOf(sessionId)).toBe(null);
    });
  });
});
