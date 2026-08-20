import { randomUUID } from "node:crypto";
import { seedAlertSession, WHOLE_DELIVERY } from "./session-helper.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  NormalizedAlert,
  TranscriptRow,
  SessionMeta,
} from "@nightwarden/shared";
import { connectTestMetrics, useTempDb } from "./temp-db.js";
import { deleteMetricsSource } from "../db/metrics.js";

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
import { recordHypothesis } from "../agent/report.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { getReport } from "../db/reports.js";
import { seedCompleteReport, seedRecommendation } from "./report-helper.js";
import { buildSeed } from "../session/seed.js";
import { buildTranscript } from "../session/transcript.js";
import {} from "../db/integrations.js";
import { verifyRecovery } from "../verification/recovery.js";
import { reconcileRecovery } from "../verification/reconciler.js";

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
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const alert: NormalizedAlert = {
  sourceAlertId: "src-1",
  labels: {},
  alertType: "ContainerDown",
  severity: "critical",
  firedAt: "2026-06-13T00:00:00.000Z",
  annotations: {},
  generatorURL: null,
  values: {},
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
    seedAlertSession(m, [alert]);

    const stored = getSession(m.sessionId);
    expect(stored).toBeDefined();
    expect(stored?.title).toBe("web-01 down");
    // Not injected and nothing left out: this alert is what opened the session,
    // which is recorded rather than worked out from when it arrived.
    expect(stored?.alerts).toEqual([
      {
        alert,
        arrivedAt: expect.any(String) as string,
        clearedAt: null,
        injected: false,
        droppedAlerts: 0,
        groupContext: null,
      },
    ]);
  });

  it("stores a chat session with no alerts at all", () => {
    const m = meta({ title: "hello" });
    createSession(m);

    expect(getSession(m.sessionId)?.alerts).toEqual([]);
  });

  it("keeps an alert that arrived after the session was already running", () => {
    const m = meta();
    const later = {
      ...alert,
      sourceAlertId: "later",
      alertType: "HighLatency",
    };
    seedAlertSession(m, [alert], "grp-arrival");
    appendSessionAlert(m.sessionId, "grp-arrival", later, WHOLE_DELIVERY);

    const stored = getSession(m.sessionId)!.alerts;
    expect(stored.map((entry) => entry.alert)).toEqual([alert, later]);
    /* Which one opened the session is recorded, not deduced. Both carry an
       arrival stamp and the two can land in the same millisecond, so anything
       that compared them would be reading a race rather than a fact. */
    expect(stored.map((entry) => entry.injected)).toEqual([false, true]);
    expect(stored[1]!.clearedAt).toBeNull();
  });

  it("createSession is idempotent and never clobbers the first title", () => {
    const m = meta({ title: "first" });
    seedAlertSession(m, [alert]);
    createSession({ ...m, title: "second" });

    const stored = getSession(m.sessionId);
    expect(stored?.title).toBe("first");
    expect(stored?.alerts.map((entry) => entry.alert)).toEqual([alert]);
  });

  it("persists and reads back a transcript ordered by seq", () => {
    const m = meta();
    seedAlertSession(m, [alert]);
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
    // The user did not write it, so the transcript must not show it as
    // theirs; the model answered it, so a resume that dropped it would leave
    // that answer replying to nothing.
    const m = meta();
    seedAlertSession(m, [alert]);
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
    // Stamped onto the part on the way to disk, because the provider message has
    // nowhere to put it. Without it a reload draws a miss as a crash.
    const m = meta();
    seedAlertSession(m, [alert]);
    appendTranscriptRows([
      {
        ...msg(m.sessionId, 0, { kind: "assistant" }),
        parts: [
          { type: "tool_call", id: "tu-miss", name: "Read", input: {} },
          {
            type: "tool_result",
            toolCallId: "tu-miss",
            output: "not found",
            outcome: "expected_miss",
          },
        ],
      },
    ]);

    const card = buildTranscript(m.sessionId).find(
      (item) => item.kind === "tool_call",
    );
    expect(card?.state).toEqual({
      phase: "complete",
      result: "not found",
      outcome: "expected_miss",
    });
  });

  it("rejects a duplicate (session_id, seq) so a hole can never be re-filled", () => {
    const m = meta();
    seedAlertSession(m, [alert]);
    appendTranscriptRows([msg(m.sessionId, 0)]);

    expect(() => appendTranscriptRows([msg(m.sessionId, 0)])).toThrow();
  });

  it("appends a batch atomically: a duplicate in the batch rolls back the whole turn", () => {
    const m = meta();
    seedAlertSession(m, [alert]);
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
    seedAlertSession(older, [alert]);
    seedAlertSession(newer, [alert]);
    seedAlertSession(other, [alert]);

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
        seedAlertSession(
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
      seedAlertSession(waiting, [alert]);
      appendRowsAndInterrupt([msg(waiting.sessionId, 0)], {
        sessionId: waiting.sessionId,
        toolUseId: "tu-float",
        kind: "approval",
        completedResults: [],
        claimedAt: null,
      });
      seedAlertSession(meta({ title: "newer than waiting" }), [alert]);

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
    seedAlertSession(m, [alert]);
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
    seedAlertSession(m, [alert]);
    seedCompleteReport(m.sessionId);
    expect(getReport(m.sessionId)).toBeDefined();

    deleteSession(m.sessionId);

    expect(getReport(m.sessionId)).toBeUndefined();
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
      seedAlertSession(m, [{ ...alert, sourceAlertId }]);
      return m.sessionId;
    }

    it("says nothing about a session that is not under investigation", () => {
      const m = meta();
      createSession(m);
      expect(statusOf(m.sessionId)).toBeNull();
    });

    // Running a write is evidence of effort, not of outcome, and whether an
    // approved shell command even changed anything is unknowable. The alert that
    // fired is the only thing that can say the incident is over.
    it("does not resolve on a write while the alert it fired on still fires", () => {
      const sessionId = investigation();
      seedCompleteReport(sessionId);
      appendTranscriptRows([
        {
          sessionId,
          seq: 0,
          kind: "assistant",
          content: "",
          parts: [
            {
              type: "tool_call",
              id: "tu-exec",
              name: "RestartDockerService",
              input: { target: "docker/app/web" },
            },
            { type: "tool_result", toolCallId: "tu-exec", output: "ok" },
          ],
          timestamp: new Date().toISOString(),
        },
      ]);
      expect(statusOf(sessionId)).toBe("inconclusive");
    });

    // No alert means no condition, and no condition means nothing can ever say
    // the incident is over - so it never reads Resolved rather than reading it
    // on the strength of something having run.
    it("never resolves a session that fired on no alert", () => {
      const m = meta();
      createSession(m, true);
      seedCompleteReport(m.sessionId);
      expect(statusOf(m.sessionId)).toBe("inconclusive");
    });

    it("reads Resolved when the alert cleared, with nothing run", () => {
      const sourceAlertId = randomUUID();
      const sessionId = investigation(sourceAlertId);
      const untouched = investigation();
      seedCompleteReport(sessionId);
      seedCompleteReport(untouched);
      expect(statusOf(sessionId)).toBe("inconclusive");

      // The ids it answers with are what ingest publishes REPORT_UPDATED for, so
      // it names the sessions actually holding the alert, and each of them once.
      expect(markAlertCleared(sourceAlertId, new Date().toISOString())).toEqual(
        [sessionId],
      );
      expect(statusOf(sessionId)).toBe("resolved");
      expect(statusOf(untouched)).toBe("inconclusive");
    });

    it("stays unresolved until every alert of a batch has cleared", () => {
      // A batch elects no primary, so one symptom recovering while the others
      // still fire is not the incident being over.
      const m = meta();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      seedAlertSession(
        m,
        ids.map((sourceAlertId) => ({ ...alert, sourceAlertId })),
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
      seedRecommendation(sessionId, "restart the container");
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

    // It used to answer null here, which put the row in no group on the page
    // while it still counted in the queue total - so the stepper read "3 / 12"
    // over eleven rows. Every investigation lands in exactly one group.
    it("reads Inconclusive when a cause was found but nothing was recommended", () => {
      const sessionId = investigation();
      recordHypothesis(sessionId, {
        statement: "the deploy set the cache size",
        verdict: "trigger",
        finding: "the climb starts at the merge",
        evidenceIds: ["tu-never-ran"],
      });
      expect(statusOf(sessionId)).toBe("inconclusive");
    });

    /* Verification asks whoever owns the condition, never the model, and writes
       the same clearedAt the resolved webhook writes. Stubbing fetch is the
       system boundary; everything below it is ours. */
    describe("verifying the condition against its own source", () => {
      function rulesAnswer(alerts: unknown[]): void {
        vi.stubGlobal(
          "fetch",
          vi.fn(() =>
            Promise.resolve(
              new Response(
                JSON.stringify({
                  status: "success",
                  data: {
                    groups: [
                      {
                        rules: [
                          { name: alert.alertType, type: "alerting", alerts },
                        ],
                      },
                    ],
                  },
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
            ),
          ),
        );
      }

      // An alert as a real webhook delivers it: the rule's own series labels
      // plus the external_labels Prometheus attaches on the way to Alertmanager.
      function labelledInvestigation(labels: Record<string, string>): string {
        const m = meta();
        seedAlertSession(m, [
          { ...alert, sourceAlertId: randomUUID(), labels },
        ]);
        return m.sessionId;
      }

      let sourceId: string;

      beforeEach(() => {
        sourceId = connectTestMetrics({
          queryUrl: "http://prom.test",
          rulesUrl: "http://prom.test",
        });
      });

      afterEach(() => {
        vi.unstubAllGlobals();
        deleteMetricsSource(sourceId);
      });

      it("resolves once the rules API no longer holds the rule firing", async () => {
        const sessionId = investigation();
        seedCompleteReport(sessionId);
        expect(statusOf(sessionId)).toBe("inconclusive");

        rulesAnswer([]);
        await expect(verifyRecovery(sessionId)).resolves.toBe("confirmed");
        // Written to the same field the webhook writes, so the two ways of
        // learning it converge on one record and status stays a plain read.
        expect(statusOf(sessionId)).toBe("resolved");
      });

      // A fix lands, the rule's `for:` elapses, and the alert goes quiet minutes
      // after the run ended. The finish gate cannot hear that; the sweep can.
      it("resolves after the run ended, with no webhook, when the sweep next asks", async () => {
        const sessionId = investigation();
        seedCompleteReport(sessionId);
        expect(statusOf(sessionId)).toBe("inconclusive");

        rulesAnswer([]);
        await reconcileRecovery();

        expect(statusOf(sessionId)).toBe("resolved");
      });

      it("leaves a still-firing rule alone", async () => {
        const sessionId = investigation();
        seedCompleteReport(sessionId);

        rulesAnswer([{ state: "firing", labels: {} }]);
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
        expect(statusOf(sessionId)).toBe("inconclusive");
      });

      // The rule is true but has not held long enough to fire. Reading that as
      // recovery would resolve an incident on its way back.
      it("does not call a pending rule recovered", async () => {
        const sessionId = investigation();
        rulesAnswer([{ state: "pending", labels: {} }]);
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
      });

      // external_labels ride to Alertmanager but never reach rule evaluation, so
      // a firing rule must not resolve however far the two label sets differ.
      it("never resolves an alert carrying labels the rules API cannot have", async () => {
        const sessionId = labelledInvestigation({
          alertname: "ContainerDown",
          severity: "critical",
          container: "payments-api",
          cluster: "prod-eu",
          monitor: "primary",
        });
        seedCompleteReport(sessionId);

        rulesAnswer([
          {
            state: "firing",
            labels: {
              alertname: "ContainerDown",
              severity: "critical",
              container: "payments-api",
            },
          },
        ]);
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
        expect(statusOf(sessionId)).toBe("inconclusive");
      });

      // The load-bearing case: an unanswerable question is not a yes. If this
      // ever collapses into "confirmed", an unreachable Prometheus silently
      // resolves every open incident.
      it("never reads an unreachable source as recovery", async () => {
        const sessionId = investigation();
        seedCompleteReport(sessionId);

        vi.stubGlobal(
          "fetch",
          vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
        );
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
        expect(statusOf(sessionId)).toBe("inconclusive");
      });

      it("never reads a rule Prometheus does not know as recovery", async () => {
        const sessionId = investigation();
        rulesAnswer([]);
        // Answering about some other rule is not answering about this one.
        vi.stubGlobal(
          "fetch",
          vi.fn(() =>
            Promise.resolve(
              new Response(
                JSON.stringify({ status: "success", data: { groups: [] } }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
            ),
          ),
        );
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
        expect(statusOf(sessionId)).toBe("inconclusive");
      });

      it("has nothing to verify on a session no alert opened", async () => {
        const m = meta();
        createSession(m, true);
        await expect(verifyRecovery(m.sessionId)).resolves.toBe("no_condition");
      });
    });

    it("gives every investigation a group, whatever its record holds", () => {
      const sessionId = investigation();
      recordHypothesis(sessionId, {
        statement: "something downstream broke",
        verdict: "symptom",
        finding: "it followed the upstream failure",
        evidenceIds: ["tu-never-ran"],
      });
      const rows = listSessionPage(500, 0).rows.filter((r) => r.investigation);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status !== null)).toBe(true);
      expect(
        rows.find((r) => r.sessionId === sessionId)?.status,
      ).not.toBeNull();
    });
  });

  // The line answers the question its status raises, so the list can be triaged
  // without opening every row. Every branch is a record or the model's prose.
  describe("the finding line", () => {
    function rowOf(sessionId: string) {
      return listSessionPage(500, 0).rows.find(
        (r) => r.sessionId === sessionId,
      );
    }
    function findingOf(sessionId: string): string | null | undefined {
      return rowOf(sessionId)?.finding;
    }
    function investigation(sourceAlertId = randomUUID()): string {
      const m = meta();
      seedAlertSession(m, [{ ...alert, sourceAlertId }]);
      return m.sessionId;
    }

    // A citation survives only if the call it names is in the transcript.
    function cite(sessionId: string, toolUseId: string, seq: number): string {
      appendTranscriptRows([
        {
          ...msg(sessionId, seq, { kind: "assistant" }),
          parts: [
            { type: "tool_call", id: toolUseId, name: "Read", input: {} },
            { type: "tool_result", toolCallId: toolUseId, output: "ok" },
          ],
        },
      ]);
      return toolUseId;
    }

    it("says what a gated session waits on, by the kind of answer it needs", () => {
      const sessionId = investigation();
      appendRowsAndInterrupt([msg(sessionId, 0)], {
        sessionId,
        toolUseId: "tu-gate",
        kind: "approval",
        completedResults: [],
        claimedAt: null,
      });
      expect(findingOf(sessionId)).toBe("Waiting on approval");
    });

    it("names the fix a finished run is waiting on somebody to take", () => {
      const sessionId = investigation();
      seedCompleteReport(sessionId);
      seedRecommendation(sessionId, "raise the pod memory limit to 2Gi");
      expect(findingOf(sessionId)).toBe("raise the pod memory limit to 2Gi");
    });

    // With no fix written the claim stands in for one, and the claim that leads
    // is the most confident the run reached, not the last thing it typed.
    it("leads with the most confident claim, the newer of two equals winning", () => {
      const sessionId = investigation();
      recordHypothesis(sessionId, {
        statement: "the cache size grew at the merge",
        verdict: "symptom",
        finding: "it climbs with the cache",
        evidenceIds: [cite(sessionId, "tu-1", 0)],
      });
      recordHypothesis(sessionId, {
        statement: "the sidecar leaks between deploys",
        verdict: "root_cause",
        finding: "the leak survives the restart",
        evidenceIds: [cite(sessionId, "tu-2", 1)],
      });
      // The cause outranks the symptom even though the symptom settled first.
      expect(findingOf(sessionId)).toBe("the sidecar leaks between deploys");

      recordHypothesis(sessionId, {
        statement: "the pool never returns its connections",
        verdict: "root_cause",
        finding: "the pool is full at the crash",
        evidenceIds: [cite(sessionId, "tu-3", 2)],
      });
      expect(findingOf(sessionId)).toBe(
        "the pool never returns its connections",
      );
    });

    it("says the condition recovered, never which fix ran", () => {
      const sourceAlertId = randomUUID();
      const sessionId = investigation(sourceAlertId);
      seedCompleteReport(sessionId);
      markAlertCleared(sourceAlertId, new Date().toISOString());
      expect(findingOf(sessionId)).toBe("Alert condition recovered");
    });

    it("names what an inconclusive run ruled out, and nothing when it recorded nothing", () => {
      const ruled = investigation();
      seedCompleteReport(ruled); // one disproven hypothesis
      expect(findingOf(ruled)).toBe("Ruled out: seeded by test");
      expect(findingOf(investigation())).toBeNull();
    });

    it("gives a failed run its own error text", () => {
      const sessionId = investigation();
      appendTranscriptRows([
        msg(sessionId, 0, { kind: "error", content: "the provider timed out" }),
      ]);
      expect(findingOf(sessionId)).toBe("the provider timed out");
    });

    it("leaves a session that is not under investigation with no finding", () => {
      const m = meta();
      createSession(m);
      expect(findingOf(m.sessionId)).toBeNull();
    });

    // The rank orders rows; the label is what the user wrote and is the
    // only thing rendered.
    it("carries the severity rank and the label's own word apart", () => {
      const m = meta();
      seedAlertSession(m, [
        {
          ...alert,
          sourceAlertId: randomUUID(),
          severity: null,
          labels: { severity: "P1" },
        },
      ]);
      expect(rowOf(m.sessionId)).toMatchObject({
        severity: null,
        severityLabel: "P1",
      });
    });
  });

  // Claims about every session, which a page of rows cannot answer: a count of
  // loaded pages climbs as the user scrolls and reads zero before they do.
  describe("the page's counts and its kind filter", () => {
    function investigation(): string {
      const m = meta();
      seedAlertSession(m, [{ ...alert, sourceAlertId: randomUUID() }]);
      return m.sessionId;
    }

    it("totals every investigation, so a record's place in the queue is true", () => {
      const before = listSessionPage(1, 0).investigationTotal;
      investigation();
      createSession(meta()); // a chat adds nothing to the total
      expect(listSessionPage(1, 0).investigationTotal).toBe(before + 1);
    });

    it("filters the rows by kind, leaving the counts alone", () => {
      const chat = meta();
      createSession(chat);
      const only = listSessionPage(500, 0, "investigation");
      expect(only.rows.every((r) => r.investigation)).toBe(true);
      expect(only.rows.some((r) => r.sessionId === chat.sessionId)).toBe(false);

      const chats = listSessionPage(500, 0, "chat");
      expect(chats.rows.every((r) => !r.investigation)).toBe(true);
      expect(chats.rows.some((r) => r.sessionId === chat.sessionId)).toBe(true);
      expect(chats.investigationTotal).toBe(only.investigationTotal);
    });
  });
});
