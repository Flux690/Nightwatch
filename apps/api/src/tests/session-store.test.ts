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
import { deleteMetricsSource } from "../integrations/metrics/store.js";

import {
  appendSessionAlert,
  markAlertCleared,
} from "../session/alerts-store.js";
import {
  createSession,
  deleteSession,
  getSession,
  listSessionFacts,
} from "../session/store.js";
import {
  appendRowsAndPark,
  appendTranscriptRows,
  getTranscriptRows,
} from "../session/transcript-store.js";
import { listSessionPage } from "../session/list.js";
import {
  highestEvidenceNumber,
  withEvidenceIds,
} from "../agent/evidence-id.js";
import { recordHypothesis } from "../agent/report.js";
import { hasPendingHumanInput } from "../session/gate-store.js";
import { getRecord } from "../session/record-store.js";
import { seedCompleteReport, seedRecommendation } from "./report-helper.js";
import { buildSeed } from "../session/seed.js";
import { buildTranscript } from "../session/transcript.js";
import {} from "../integrations/store.js";
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
  firedAt: "2026-06-13T00:00:00.000Z",
  annotations: {},
  generatorURL: null,
  values: {},
};

describe("API-local session store", () => {
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("round-trips a session with the alert that opened it", async () => {
    const m = meta();
    await seedAlertSession(m, [alert]);

    const stored = await getSession(m.sessionId);
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

  it("stores a chat session with no alerts at all", async () => {
    const m = meta({ title: "hello" });
    await createSession(m);

    expect((await getSession(m.sessionId))?.alerts).toEqual([]);
  });

  it("keeps an alert that arrived after the session was already running", async () => {
    const m = meta();
    const later = {
      ...alert,
      sourceAlertId: "later",
      alertType: "HighLatency",
    };
    await seedAlertSession(m, [alert], "grp-arrival");
    await appendSessionAlert(m.sessionId, "grp-arrival", later, WHOLE_DELIVERY);

    const stored = (await getSession(m.sessionId))!.alerts;
    expect(stored.map((entry) => entry.alert)).toEqual([alert, later]);
    // Recorded, not deduced: both carry an arrival stamp and can land in the
    // same millisecond, so comparing them would read a race.
    expect(stored.map((entry) => entry.injected)).toEqual([false, true]);
    expect(stored[1]!.clearedAt).toBeNull();
  });

  it("createSession is idempotent and never clobbers the first title", async () => {
    const m = meta({ title: "first" });
    await seedAlertSession(m, [alert]);
    await createSession({ ...m, title: "second" });

    const stored = await getSession(m.sessionId);
    expect(stored?.title).toBe("first");
    expect(stored?.alerts.map((entry) => entry.alert)).toEqual([alert]);
  });

  it("persists and reads back a transcript ordered by seq", async () => {
    const m = meta();
    await seedAlertSession(m, [alert]);
    // Insert out of order to prove ordering is by seq, not insertion.
    await appendTranscriptRows([msg(m.sessionId, 1), msg(m.sessionId, 0)]);
    await appendTranscriptRows([msg(m.sessionId, 2)]);

    const transcript = await getTranscriptRows(m.sessionId);
    expect(transcript.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(transcript[0].kind).toBe("user");
    expect(transcript[1].kind).toBe("assistant");
    expect(transcript[0].parts).toEqual([{ type: "text", text: "message 0" }]);
  });

  it("replays a harness message to the model and draws it for nobody", async () => {
    // The user did not write it, so it must not read as theirs, and a resume
    // that dropped it would leave the model's answer replying to nothing.
    const m = meta();
    await seedAlertSession(m, [alert]);
    await appendTranscriptRows([
      msg(m.sessionId, 0),
      msg(m.sessionId, 1),
      msg(m.sessionId, 2, {
        kind: "harness",
        content: "Your investigation record is not finished.",
        parts: [
          { type: "text", text: "Your investigation record is not finished." },
        ],
      }),
      msg(m.sessionId, 3),
    ]);

    const drawn = JSON.stringify(await buildTranscript(m.sessionId));
    expect(drawn).not.toContain("Your investigation record");
    expect(await buildTranscript(m.sessionId)).toHaveLength(3);

    // The seed speaks the provider's vocabulary, where there are two roles and
    // "harness" is not one of them: it goes back as the user turn it was.
    const seeded = await buildSeed(m.sessionId);
    expect(seeded).toHaveLength(4);
    expect(seeded[2]).toMatchObject({
      role: "user",
      content: "Your investigation record is not finished.",
    });
  });

  it("carries a tool call's toolOutcome class into the rebuilt transcript", async () => {
    // Stamped onto the part on the way to disk, because the provider message has
    // nowhere to put it. Without it a reload draws a miss as a crash.
    const m = meta();
    await seedAlertSession(m, [alert]);
    await appendTranscriptRows([
      {
        ...msg(m.sessionId, 0, { kind: "assistant" }),
        parts: [
          { type: "tool_call", id: "tu-miss", name: "Read", input: {} },
          {
            type: "tool_result",
            toolCallId: "tu-miss",
            output: "not found",
            toolOutcome: "expected_miss",
          },
        ],
      },
    ]);

    const card = (await buildTranscript(m.sessionId)).find(
      (item) => item.kind === "tool_call",
    );
    expect(card?.state).toEqual({
      phase: "complete",
      result: "not found",
      toolOutcome: "expected_miss",
    });
  });

  it("rejects a duplicate (session_id, seq) so a hole can never be re-filled", async () => {
    const m = meta();
    await seedAlertSession(m, [alert]);
    await appendTranscriptRows([msg(m.sessionId, 0)]);

    await expect(appendTranscriptRows([msg(m.sessionId, 0)])).rejects.toThrow();
  });

  it("appends a batch atomically: a duplicate in the batch rolls back the whole turn", async () => {
    const m = meta();
    await seedAlertSession(m, [alert]);
    await appendTranscriptRows([msg(m.sessionId, 0)]);

    // seq 1 is new, seq 0 collides; the batch must be all-or-nothing.
    await expect(
      appendTranscriptRows([msg(m.sessionId, 1), msg(m.sessionId, 0)]),
    ).rejects.toThrow();
    expect((await getTranscriptRows(m.sessionId)).map((t) => t.seq)).toEqual([
      0,
    ]);
  });

  it("lists sessions newest first", async () => {
    const older = meta({
      title: "older",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = meta({
      title: "newer",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const other = meta({ title: "other" });
    await seedAlertSession(older, [alert]);
    await seedAlertSession(newer, [alert]);
    await seedAlertSession(other, [alert]);

    const list = (await listSessionFacts(100, 0, "investigation")).facts.filter(
      (session) =>
        [other.sessionId, newer.sessionId, older.sessionId].includes(
          session.sessionId,
        ),
    );
    expect(list.map((s) => s.title)).toEqual(["other", "newer", "older"]);
  });

  describe("pagination", () => {
    // Distinct timestamps so the expected order is the one under test rather
    // than the id tiebreaker's.
    async function seedSessions(count: number, prefix: string): Promise<void> {
      for (let i = 0; i < count; i++) {
        await seedAlertSession(
          meta({
            title: `${prefix}-${i}`,
            createdAt: `2026-03-01T00:00:${String(i).padStart(2, "0")}.000Z`,
          }),
          [alert],
        );
      }
    }

    it("reaches sessions beyond the first page", async () => {
      await seedSessions(5, "page");

      const first = await listSessionFacts(2, 0, "investigation");
      const second = await listSessionFacts(
        2,
        first.nextOffset ?? 0,
        "investigation",
      );

      expect(first.facts).toHaveLength(2);
      expect(first.nextOffset).toBe(2);
      expect(second.facts).toHaveLength(2);
      // No row is served on both pages, which is what the id tiebreaker buys.
      const ids = [...first.facts, ...second.facts].map((s) => s.sessionId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("reports no next offset on the last page", async () => {
      const only = await listSessionFacts(1000, 0, "investigation");
      expect(only.nextOffset).toBeNull();
    });

    it("floats a session awaiting human input above newer activity", async () => {
      const waiting = meta({
        title: "waiting",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      await seedAlertSession(waiting, [alert]);
      await appendRowsAndPark([msg(waiting.sessionId, 0)], {
        sessionId: waiting.sessionId,
        toolUseId: "tu-float",
        kind: "approval",
        completedResults: [],
        claimedAt: null,
      });
      await seedAlertSession(meta({ title: "newer than waiting" }), [alert]);

      const first = await listSessionFacts(1, 0, "investigation");
      expect(first.facts[0].sessionId).toBe(waiting.sessionId);
      expect(first.facts[0].awaitingHumanInput).toBe(true);
    });
  });

  it("returns undefined for an unknown session", async () => {
    expect(await getSession("nope")).toBeUndefined();
    expect(await getTranscriptRows("nope")).toEqual([]);
  });

  it("deleteSession removes the session, its messages, and any pending interrupt", async () => {
    const m = meta();
    await seedAlertSession(m, [alert]);
    await appendRowsAndPark([msg(m.sessionId, 0)], {
      sessionId: m.sessionId,
      toolUseId: "tu-del-1",
      kind: "approval",
      completedResults: [],
      claimedAt: null,
    });

    await deleteSession(m.sessionId);

    expect(await getSession(m.sessionId)).toBeUndefined();
    expect(await getTranscriptRows(m.sessionId)).toEqual([]);
    expect(await hasPendingHumanInput(m.sessionId)).toBe(false);
  });

  it("deleteSession on an unknown session is a no-op", async () => {
    await expect(deleteSession("nope")).resolves.toBeUndefined();
  });

  it("deleteSession removes the report (it has no reason to outlive the session)", async () => {
    const m = meta();
    await seedAlertSession(m, [alert]);
    await seedCompleteReport(m.sessionId);
    expect(await getRecord(m.sessionId)).toBeDefined();

    await deleteSession(m.sessionId);

    expect(await getRecord(m.sessionId)).toBeUndefined();
  });

  it("rejects a transcript message for a session that does not exist (foreign keys enforced)", async () => {
    await expect(
      appendTranscriptRows([msg("ghost-session", 0)]),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  // The five words and nothing else. Every one of them is derived from the
  // action log, the alert or the hypothesis rows; none is ever declared.
  describe("derived status", () => {
    /* A citation is an evidence id the model was issued, so a test handing a raw
       tool_use id describes something production refuses. */
    async function seedCitedCall(sessionId: string): Promise<string> {
      await appendTranscriptRows([
        {
          ...msg(sessionId, 0, { kind: "assistant" }),
          parts: [
            { type: "tool_call", id: "tu-seed", name: "Read", input: {} },
            { type: "tool_result", toolCallId: "tu-seed", output: "ok" },
          ],
        },
      ]);
      return "e1";
    }

    async function statusOf(sessionId: string): Promise<string | null> {
      const row = (await listSessionPage(200, 0, "investigation")).rows.find(
        (r) => r.sessionId === sessionId,
      );
      return row?.status ?? null;
    }

    // Its own alert id per session: clearing one must not settle another's.
    async function investigation(
      sourceAlertId = randomUUID(),
    ): Promise<string> {
      const m = meta();
      await seedAlertSession(m, [{ ...alert, sourceAlertId }]);
      return m.sessionId;
    }

    it("says nothing about a session that is not under investigation", async () => {
      const m = meta();
      await createSession(m);
      expect(await statusOf(m.sessionId)).toBeNull();
    });

    // A write is evidence of effort, not outcome. The alert that fired is the
    // only thing that can say the incident is over.
    it("does not resolve on a write while the alert it fired on still fires", async () => {
      const sessionId = await investigation();
      await seedCompleteReport(sessionId);
      await appendTranscriptRows([
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
              input: { target: "prod-1/app/web" },
            },
            { type: "tool_result", toolCallId: "tu-exec", output: "ok" },
          ],
          timestamp: new Date().toISOString(),
        },
      ]);
      expect(await statusOf(sessionId)).toBe("completed");
    });

    // No alert means no condition, and no condition means nothing can say the
    // incident is over, so it never reads Resolved.
    it("never resolves a session that fired on no alert", async () => {
      const m = meta();
      await createSession(m, true);
      await seedCompleteReport(m.sessionId);
      expect(await statusOf(m.sessionId)).toBe("completed");
    });

    it("reads Resolved when the alert cleared, with nothing run", async () => {
      const sourceAlertId = randomUUID();
      const sessionId = await investigation(sourceAlertId);
      const untouched = await investigation();
      await seedCompleteReport(sessionId);
      await seedCompleteReport(untouched);
      expect(await statusOf(sessionId)).toBe("completed");

      // The ids it answers with are what ingest publishes REPORT_UPDATED for, so
      // it names the sessions actually holding the alert, and each of them once.
      expect(
        await markAlertCleared(
          sourceAlertId,
          alert.firedAt,
          new Date().toISOString(),
        ),
      ).toEqual([sessionId]);
      expect(await statusOf(sessionId)).toBe("resolved");
      expect(await statusOf(untouched)).toBe("completed");
    });

    /* A fingerprint hashes the labels, so the same condition firing months later
       carries the same one. Clearing the new firing must not close the old. */
    it("clears the firing it names, not an older one sharing its fingerprint", async () => {
      const sourceAlertId = randomUUID();
      const january = meta();
      await seedAlertSession(january, [
        { ...alert, sourceAlertId, firedAt: "2026-01-03T02:00:00.000Z" },
      ]);
      const august = meta();
      await seedAlertSession(august, [
        { ...alert, sourceAlertId, firedAt: "2026-08-12T14:00:00.000Z" },
      ]);
      await seedCompleteReport(january.sessionId);
      await seedCompleteReport(august.sessionId);

      expect(
        await markAlertCleared(
          sourceAlertId,
          "2026-08-12T14:00:00.000Z",
          new Date().toISOString(),
        ),
      ).toEqual([august.sessionId]);
      expect(await statusOf(august.sessionId)).toBe("resolved");
      // January never recovered, and August recovering says nothing about it.
      expect(await statusOf(january.sessionId)).toBe("completed");
    });

    it("stays unresolved until every alert of a batch has cleared", async () => {
      // A batch elects no primary, so one symptom recovering while the others
      // still fire is not the incident being over.
      const m = meta();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await seedAlertSession(
        m,
        ids.map((sourceAlertId) => ({ ...alert, sourceAlertId })),
      );
      await seedCompleteReport(m.sessionId);

      await markAlertCleared(ids[0]!, alert.firedAt, new Date().toISOString());
      expect(await statusOf(m.sessionId)).toBe("completed");
      await markAlertCleared(ids[1]!, alert.firedAt, new Date().toISOString());
      expect(await statusOf(m.sessionId)).toBe("completed");

      await markAlertCleared(ids[2]!, alert.firedAt, new Date().toISOString());
      expect(await statusOf(m.sessionId)).toBe("resolved");
    });

    it("reads Failed when the run crashed rather than stood down", async () => {
      const sessionId = await investigation();
      await appendTranscriptRows([msg(sessionId, 0, { kind: "error" })]);
      expect(await statusOf(sessionId)).toBe("failed");
    });

    /* Status reads no part of the record, so every finished run reads the same
       word. A recommendation is not a gate, since nothing marks one as acted on. */
    it("reads Completed for a finished run, whatever its record holds", async () => {
      const recommended = await investigation();
      await seedCompleteReport(recommended);
      await seedRecommendation(recommended, "restart the container");
      expect(await statusOf(recommended)).toBe("completed");

      const ruledOut = await investigation();
      await seedCompleteReport(ruledOut);
      expect(await statusOf(ruledOut)).toBe("completed");

      const named = await investigation();
      await recordHypothesis(named, {
        statement: "the deploy set the cache size",
        verdict: "trigger",
        finding: "the climb starts at the merge",
        evidenceIds: [await seedCitedCall(named)],
      });
      expect(await statusOf(named)).toBe("completed");

      // Recording nothing at all is the same answer, honestly stated.
      expect(await statusOf(await investigation())).toBe("completed");
    });

    /* Verification asks whoever owns the condition, never the model, and writes
       the same clearedAt the resolved webhook does. */
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
      async function labelledInvestigation(
        labels: Record<string, string>,
      ): Promise<string> {
        const m = meta();
        await seedAlertSession(m, [
          { ...alert, sourceAlertId: randomUUID(), labels },
        ]);
        return m.sessionId;
      }

      beforeEach(async () => {
        await connectTestMetrics({
          queryUrl: "http://prom.test",
          rulesUrl: "http://prom.test",
        });
      });

      afterEach(async () => {
        vi.unstubAllGlobals();
        await deleteMetricsSource();
      });

      it("resolves once the rules API no longer holds the rule firing", async () => {
        const sessionId = await investigation();
        await seedCompleteReport(sessionId);
        expect(await statusOf(sessionId)).toBe("completed");

        rulesAnswer([]);
        await expect(verifyRecovery(sessionId)).resolves.toBe("confirmed");
        // Written to the same field the webhook writes, so the two ways of
        // learning it converge on one record and status stays a plain read.
        expect(await statusOf(sessionId)).toBe("resolved");
      });

      // A fix lands, the rule's `for:` elapses, and the alert goes quiet minutes
      // after the run ended. The finish gate cannot hear that; the sweep can.
      it("resolves after the run ended, with no webhook, when the sweep next asks", async () => {
        const sessionId = await investigation();
        await seedCompleteReport(sessionId);
        expect(await statusOf(sessionId)).toBe("completed");

        rulesAnswer([]);
        await reconcileRecovery();

        expect(await statusOf(sessionId)).toBe("resolved");
      });

      it("leaves a still-firing rule alone", async () => {
        const sessionId = await investigation();
        await seedCompleteReport(sessionId);

        rulesAnswer([{ state: "firing", labels: {} }]);
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
        expect(await statusOf(sessionId)).toBe("completed");
      });

      // The rule is true but has not held long enough to fire. Reading that as
      // recovery would resolve an incident on its way back.
      it("does not call a pending rule recovered", async () => {
        const sessionId = await investigation();
        rulesAnswer([{ state: "pending", labels: {} }]);
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
      });

      // external_labels ride to Alertmanager but never reach rule evaluation, so
      // a firing rule must not resolve however far the two label sets differ.
      it("never resolves an alert carrying labels the rules API cannot have", async () => {
        const sessionId = await labelledInvestigation({
          alertname: "ContainerDown",
          container: "payments-api",
          cluster: "prod-eu",
          monitor: "primary",
        });
        await seedCompleteReport(sessionId);

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
        expect(await statusOf(sessionId)).toBe("completed");
      });

      // An unanswerable question is not a yes. Collapse this into "confirmed"
      // and an unreachable Prometheus silently resolves every open incident.
      it("never reads an unreachable source as recovery", async () => {
        const sessionId = await investigation();
        await seedCompleteReport(sessionId);

        vi.stubGlobal(
          "fetch",
          vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
        );
        await expect(verifyRecovery(sessionId)).resolves.toBe("unconfirmed");
        expect(await statusOf(sessionId)).toBe("completed");
      });

      it("never reads a rule Prometheus does not know as recovery", async () => {
        const sessionId = await investigation();
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
        expect(await statusOf(sessionId)).toBe("completed");
      });

      it("has nothing to verify on a session no alert opened", async () => {
        const m = meta();
        await createSession(m, true);
        await expect(verifyRecovery(m.sessionId)).resolves.toBe("no_condition");
      });
    });

    it("gives every investigation a group, whatever its record holds", async () => {
      const sessionId = await investigation();
      await recordHypothesis(sessionId, {
        statement: "something downstream broke",
        verdict: "symptom",
        finding: "it followed the upstream failure",
        evidenceIds: [await seedCitedCall(sessionId)],
      });
      const rows = (await listSessionPage(500, 0, "investigation")).rows.filter(
        (r) => r.investigation,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status !== null)).toBe(true);
      expect(
        rows.find((r) => r.sessionId === sessionId)?.status,
      ).not.toBeNull();
    });
  });

  // The line answers the question its status raises, so the list can be triaged
  // without opening every row. Every branch is a record or the model's prose.
  describe("the status line", () => {
    // Both kinds, because these cases cover a chat as well as an investigation
    // and the list is now served one kind at a time.
    async function rowOf(sessionId: string) {
      const pages = await Promise.all([
        listSessionPage(500, 0, "investigation"),
        listSessionPage(500, 0, "chat"),
      ]);
      return pages
        .flatMap((page) => page.rows)
        .find((r) => r.sessionId === sessionId);
    }
    async function statusLineOf(
      sessionId: string,
    ): Promise<string | null | undefined> {
      return (await rowOf(sessionId))?.statusLine;
    }
    async function investigation(
      sourceAlertId = randomUUID(),
    ): Promise<string> {
      const m = meta();
      await seedAlertSession(m, [{ ...alert, sourceAlertId }]);
      return m.sessionId;
    }

    // A citation survives only if the call it names is in the transcript, and
    // is stamped as the loop stamps it, so the handle returned is the stored one.
    async function cite(
      sessionId: string,
      toolUseId: string,
      seq: number,
    ): Promise<string> {
      const from =
        highestEvidenceNumber(await getTranscriptRows(sessionId)) + 1;
      await appendTranscriptRows(
        withEvidenceIds(
          [
            {
              ...msg(sessionId, seq, { kind: "assistant" }),
              parts: [
                { type: "tool_call", id: toolUseId, name: "Read", input: {} },
                { type: "tool_result", toolCallId: toolUseId, output: "ok" },
              ],
            },
          ],
          from,
        ),
      );
      return `e${from}`;
    }

    it("says what a gated session waits on, by the kind of answer it needs", async () => {
      const sessionId = await investigation();
      await appendRowsAndPark([msg(sessionId, 0)], {
        sessionId,
        toolUseId: "tu-gate",
        kind: "approval",
        completedResults: [],
        claimedAt: null,
      });
      expect(await statusLineOf(sessionId)).toBe("Waiting on approval");
    });

    it("names the fix a finished run is waiting on somebody to take", async () => {
      const sessionId = await investigation();
      await seedCompleteReport(sessionId);
      await seedRecommendation(sessionId, "raise the pod memory limit to 2Gi");
      expect(await statusLineOf(sessionId)).toBe(
        "raise the pod memory limit to 2Gi",
      );
    });

    // With no fix written the claim stands in for one, and the claim that leads
    // is the most confident the run reached, not the last thing it typed.
    it("leads with the most confident claim, the newer of two equals winning", async () => {
      const sessionId = await investigation();
      await recordHypothesis(sessionId, {
        statement: "the cache size grew at the merge",
        verdict: "symptom",
        finding: "it climbs with the cache",
        evidenceIds: [await cite(sessionId, "tu-1", 0)],
      });
      await recordHypothesis(sessionId, {
        statement: "the sidecar leaks between deploys",
        verdict: "root_cause",
        finding: "the leak survives the restart",
        evidenceIds: [await cite(sessionId, "tu-2", 1)],
      });
      // The cause outranks the symptom even though the symptom settled first.
      expect(await statusLineOf(sessionId)).toBe(
        "the sidecar leaks between deploys",
      );

      await recordHypothesis(sessionId, {
        statement: "the pool never returns its connections",
        verdict: "root_cause",
        finding: "the pool is full at the crash",
        evidenceIds: [await cite(sessionId, "tu-3", 2)],
      });
      expect(await statusLineOf(sessionId)).toBe(
        "the pool never returns its connections",
      );
    });

    it("says the condition recovered, never which fix ran", async () => {
      const sourceAlertId = randomUUID();
      const sessionId = await investigation(sourceAlertId);
      await seedCompleteReport(sessionId);
      await markAlertCleared(
        sourceAlertId,
        alert.firedAt,
        new Date().toISOString(),
      );
      expect(await statusLineOf(sessionId)).toBe("Alert condition recovered");
    });

    it("names what a completed run ruled out, and nothing when it recorded nothing", async () => {
      const ruled = await investigation();
      await seedCompleteReport(ruled); // one disproven hypothesis
      expect(await statusLineOf(ruled)).toBe("Ruled out: seeded by test");
      expect(await statusLineOf(await investigation())).toBeNull();
    });

    it("gives a failed run its own error text", async () => {
      const sessionId = await investigation();
      await appendTranscriptRows([
        msg(sessionId, 0, { kind: "error", content: "the provider timed out" }),
      ]);
      expect(await statusLineOf(sessionId)).toBe("the provider timed out");
    });

    it("leaves a session that is not under investigation with no finding", async () => {
      const m = meta();
      await createSession(m);
      expect(await statusLineOf(m.sessionId)).toBeNull();
    });

    // The rank orders rows; the label is what the user wrote and is the
    // only thing rendered.
    it("carries the severity rank and the label's own word apart", async () => {
      const m = meta();
      await seedAlertSession(m, [
        {
          ...alert,
          sourceAlertId: randomUUID(),
          labels: { severity: "P1" },
        },
      ]);
      expect(await rowOf(m.sessionId)).toMatchObject({
        severityLabel: "P1",
      });
    });
  });

  // Claims about every session, which a page of rows cannot answer: a count of
  // loaded pages climbs as the user scrolls and reads zero before they do.
  describe("the page's counts and its kind filter", () => {
    async function investigation(): Promise<string> {
      const m = meta();
      await seedAlertSession(m, [{ ...alert, sourceAlertId: randomUUID() }]);
      return m.sessionId;
    }

    it("totals every investigation, so a record's place in the queue is true", async () => {
      const before = (await listSessionPage(1, 0, "investigation"))
        .investigationTotal;
      await investigation();
      await createSession(meta()); // a chat adds nothing to the total
      expect(
        (await listSessionPage(1, 0, "investigation")).investigationTotal,
      ).toBe(before + 1);
    });

    it("filters the rows by kind, leaving the counts alone", async () => {
      const chat = meta();
      await createSession(chat);
      const only = await listSessionPage(500, 0, "investigation");
      expect(only.rows.every((r) => r.investigation)).toBe(true);
      expect(only.rows.some((r) => r.sessionId === chat.sessionId)).toBe(false);

      const chats = await listSessionPage(500, 0, "chat");
      expect(chats.rows.every((r) => !r.investigation)).toBe(true);
      expect(chats.rows.some((r) => r.sessionId === chat.sessionId)).toBe(true);
      expect(chats.investigationTotal).toBe(only.investigationTotal);
    });
  });
});
