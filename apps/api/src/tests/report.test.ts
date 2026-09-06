import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createContractFakeProvider } from "./contract-fake-provider.js";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import type { NormalizedAlert, TranscriptRow } from "@nightwarden/shared";
import { runSession } from "../agent/loop.js";
import {
  computeConviction,
  gatedCalls,
  recordGaps,
  reportIsBehind,
  resolveEvidence,
} from "../agent/report.js";
import { REPORT_TOOLS, SUBMIT_REPORT_TOOL } from "../agent/tools/report.js";
import { REPORT_RETRY_REQUEST } from "../agent/prompts/report.js";
import { buildSeed } from "../session/seed.js";
import { executeTool } from "../agent/tools/toolset.js";
import { getRecord } from "../session/record-store.js";
import { leadingHypothesis, supersededIds } from "@nightwarden/shared";
import {
  appendTranscriptRows,
  getNextSeq,
  getTranscriptRows,
} from "../session/transcript-store.js";
import {
  highestEvidenceNumber,
  withEvidenceIds,
} from "../agent/evidence-id.js";
import { buildSessionMeta } from "../agent/loop.js";
import { seedAlertSession, seedChatSession } from "./session-helper.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../fleet/connections.js";
import { resolveCommand } from "../fleet/transport.js";
import { generateRunnerToken } from "../fleet/runners-store.js";
import { manifest } from "./manifest-helper.js";
import { buildTranscript } from "../session/transcript.js";
import { useTempDb } from "./temp-db.js";

function alert(sourceAlertId: string): NormalizedAlert {
  return {
    sourceAlertId,
    labels: {},
    alertType: "HighMemory",
    firedAt: new Date().toISOString(),
    annotations: {},
    generatorURL: null,
    values: {},
  };
}

describe("the investigation record", () => {
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
  });

  afterAll(() => {
    cleanupDb();
  });

  beforeEach(() => {
    mockCreateProvider.mockReset();
  });

  const METRICS = JSON.stringify({
    resultType: "matrix",
    series: [
      {
        metric: { __name__: "container_memory_rss", container: "web-01" },
        values: [
          [1720000000, "100"],
          [1720000060, "200"],
        ],
      },
    ],
    windowStart: "2026-07-03T00:00:00.000Z",
    windowEnd: "2026-07-03T03:00:00.000Z",
    stepSeconds: 60,
  });

  const CHANGES = JSON.stringify({
    branch: "main",
    windowStart: "2026-07-03T00:00:00.000Z",
    windowEnd: "2026-07-04T00:00:00.000Z",
    pullRequests: [
      {
        number: 482,
        title: "bump cache size",
        author: "dev",
        mergedAt: "2026-07-03T01:00:00.000Z",
        url: "https://github.com/o/r/pull/482",
      },
    ],
    commits: [],
  });

  async function appendCitableRows(rows: TranscriptRow[]): Promise<void> {
    const sessionId = rows[0]!.sessionId;
    const stamped = withEvidenceIds(
      rows,
      highestEvidenceNumber(await getTranscriptRows(sessionId)) + 1,
    );
    await appendTranscriptRows(stamped.rows);
  }

  // One record entry at a chosen instant, so a read after a remediation is
  // distinguishable from one before. The parts carry what production carries.
  async function appendCall(
    sessionId: string,
    seq: number,
    entry: { toolCallId: string; name: string; input: Record<string, unknown> },
    output: string,
    at: string,
    isError?: true,
    approved?: boolean,
  ): Promise<void> {
    // Stamped as the loop stamps it, so a call here is citable exactly when a
    // call in a real run would be.
    await appendCitableRows([
      {
        sessionId,
        seq,
        kind: "assistant",
        content: `[tool: ${entry.name}]`,
        parts: [
          {
            type: "tool_call",
            toolCallId: entry.toolCallId,
            name: entry.name,
            input: entry.input,
          },
        ],
        timestamp: at,
      },
      {
        sessionId,
        seq: seq + 1,
        kind: "user",
        content: "results",
        parts: [
          {
            type: "tool_result",
            toolCallId: entry.toolCallId,
            output,
            ...(isError === true && { isError: true }),
          },
          ...(approved === undefined
            ? []
            : [
                {
                  type: "tool_approval" as const,
                  toolCallId: entry.toolCallId,
                  approved,
                },
              ]),
        ],
        timestamp: at,
      },
    ]);
  }

  // tu-1 a Prometheus range query, tu-2 a GitHub change list: two sources, so
  // citing both is corroboration and citing either alone is not.
  async function seedTranscript(sessionId: string): Promise<void> {
    await seedAlertSession(
      { sessionId, title: "t", createdAt: new Date().toISOString() },
      [alert("seed")],
    );
    await appendCall(
      sessionId,
      0,
      {
        toolCallId: "tu-1",
        name: "QueryMetricsRange",
        input: { query: "rss" },
      },
      METRICS,
      "2026-07-03T02:00:00.000Z",
    );
    await appendCall(
      sessionId,
      2,
      { toolCallId: "tu-2", name: "GetRecentChanges", input: {} },
      CHANGES,
      "2026-07-03T02:01:00.000Z",
    );
  }

  // Written down before it runs, as the loop writes it, so a refusal here reads
  // the same transcript a refusal in a real run reads.
  async function call(
    toolName: string,
    sessionId: string,
    input: Record<string, unknown>,
  ): Promise<{ content: unknown; isError?: true }> {
    const toolCallId = `tu-${toolName}-${randomUUID()}`;
    await appendCitableRows([
      {
        sessionId,
        seq: await getNextSeq(sessionId),
        kind: "assistant",
        content: `[tool: ${toolName}]`,
        parts: [
          { type: "tool_call", toolCallId: toolCallId, name: toolName, input },
        ],
        timestamp: new Date().toISOString(),
      },
    ]);
    const tool = REPORT_TOOLS.find((t) => t.schema.name === toolName);
    return await executeTool(tool!, input, {
      sessionId,
      toolCallId,
      toolCallCeilingMs: 15_000,
    });
  }

  // Records a tested hypothesis and returns the id the system assigned to it.
  async function record(
    sessionId: string,
    statement: string,
    verdict: string,
    evidenceIds: string[],
    finding = "",
    supersedes = "",
  ): Promise<string> {
    await call("RecordHypothesis", sessionId, {
      statement,
      verdict,
      finding,
      evidenceIds,
      supersedes,
    });
    const hypotheses = (await getRecord(sessionId))!.hypotheses;
    return hypotheses[hypotheses.length - 1]!.id;
  }

  // Every field is required, so a case about one blank field overrides that
  // field and takes the rest from here.
  async function submit(
    sessionId: string,
    input: Record<string, unknown>,
  ): Promise<{ content: unknown; isError?: true }> {
    const complete = {
      headline: "the cache bump raised the memory floor",
      affected: "web-01",
      impact: "nine minutes of failed reads",
      recommendation: "revert PR #482",
      ...input,
    };
    return await executeTool(SUBMIT_REPORT_TOOL, complete, {
      sessionId,
      toolCallId: "tu-submit",
      toolCallCeilingMs: 15_000,
    });
  }

  describe("recording a hypothesis", () => {
    it("records what was tested and how it settled as one act", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);

      const id = await record(
        sessionId,
        "the cache bump leaks",
        "root_cause",
        ["e1"],
        "the climb starts at the merge",
      );
      const stored = (await getRecord(sessionId))!.hypotheses[0]!;
      expect(stored).toMatchObject({
        id,
        statement: "the cache bump leaks",
        verdict: "root_cause",
        finding: "the climb starts at the merge",
        evidenceIds: ["e1"],
      });
      expect(stored.recordedAt).not.toBe("");
    });

    it("expresses all five verdicts, every one of them settled", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      const verdicts = [
        "root_cause",
        "trigger",
        "symptom",
        "contributing_factor",
        "disproven",
      ];
      for (const verdict of verdicts) {
        await record(sessionId, `about ${verdict}`, verdict, ["e1"]);
      }
      expect(
        (await getRecord(sessionId))!.hypotheses.map((h) => h.verdict),
      ).toEqual(verdicts);
    });

    it("refuses a verdict that is not one of the five", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      const result = await call("RecordHypothesis", sessionId, {
        statement: "the cache bump leaks",
        verdict: "open",
        finding: "still looking",
        evidenceIds: ["e1"],
      });
      expect(result.isError).toBe(true);
      expect(await getRecord(sessionId)).toBeUndefined();
    });

    it("refuses a claim with nothing behind it, on any verdict", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      for (const verdict of ["root_cause", "disproven"]) {
        const result = await call("RecordHypothesis", sessionId, {
          statement: "a hunch",
          verdict,
          finding: "no reason given",
          evidenceIds: [],
        });
        expect(result.isError).toBe(true);
        // The one rule broken most often, so the refusal says what to do about
        // it rather than only which field failed.
        expect(String(result.content)).toContain("at least one citation");
      }
      expect(await getRecord(sessionId)).toBeUndefined();
    });

    /* Append-only: there is no call that rewrites a row, so a changed mind is a
       second record beside the first rather than an edit of it. */
    it("keeps a claim the run later disagreed with beside the one that replaced it", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["e1"]);
      await record(sessionId, "the cache bump leaks", "disproven", ["e2"]);

      expect(
        (await getRecord(sessionId))!.hypotheses.map((h) => [h.id, h.verdict]),
      ).toEqual([
        ["h1", "root_cause"],
        ["h2", "disproven"],
      ]);
    });

    /* The link is what lets the run say which claim it now stands behind
       without deleting the one it changed its mind about. */
    it("lets a claim replace an earlier one without removing it", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      const first = await record(sessionId, "the disk filled", "root_cause", [
        "e1",
      ]);
      await record(
        sessionId,
        "the volume is undersized",
        "root_cause",
        ["e2"],
        "",
        first,
      );

      const { hypotheses } = (await getRecord(sessionId))!;
      expect(hypotheses).toHaveLength(2);
      expect(hypotheses[1]!.supersedes).toBe("h1");
      // Both stand on the record; only the second can lead.
      expect(leadingHypothesis(hypotheses)!.id).toBe("h2");
      expect(supersededIds(hypotheses)).toEqual(new Set(["h1"]));
    });

    it("records the claim anyway when it names a replacement that does not exist", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      const result = await call("RecordHypothesis", sessionId, {
        statement: "the volume is undersized",
        verdict: "root_cause",
        finding: "",
        evidenceIds: ["e1"],
        supersedes: "h9",
      });

      // The claim is worth keeping even when what it replaces was named wrongly,
      // and the model is told which half of its call did not land.
      const stored = (await getRecord(sessionId))!.hypotheses[0]!;
      expect(stored.statement).toBe("the volume is undersized");
      expect(stored.supersedes).toBeUndefined();
      expect(String(result.content)).toContain("h9 is not a claim");
    });

    /* All of them or none: keeping the half that resolved would change the claim
       the model made, and drop it from corroborated to cited without saying so. */
    it("refuses a claim citing one real call and one that names nothing", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      const refused = await call("RecordHypothesis", sessionId, {
        statement: "the cache bump leaks",
        verdict: "root_cause",
        finding: "",
        evidenceIds: ["e1", "e9"],
      });

      expect(await getRecord(sessionId)).toBeUndefined();
      // Told which one failed, and the range it could have picked from.
      expect(String(refused.content)).toContain("e9");
      expect(String(refused.content)).toContain("e1 through e2");
    });
  });

  describe("the written report", () => {
    it("writes the prose the record has no field for, over a record it leaves alone", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["e1"]);

      await submit(sessionId, {
        summary:
          "web-01 was OOM-killed because the cache bump raised its floor",
        timeline: [
          {
            at: "2026-07-03T02:00:00.000Z",
            what: "memory crossed the limit",
            evidenceId: "e1",
          },
        ],
        impact: "nine minutes of failed reads",
        recommendation: "revert PR #482",
      });

      const written = (await getRecord(sessionId))!;
      expect(written.report).toMatchObject({
        summary:
          "web-01 was OOM-killed because the cache bump raised its floor",
        impact: "nine minutes of failed reads",
        recommendation: "revert PR #482",
      });
      // The claims it was written from are untouched by the writing.
      expect(written.hypotheses).toHaveLength(1);
      expect(written.hypotheses[0]!.verdict).toBe("root_cause");
    });

    it("drops a timeline citation naming no call, and keeps the entry", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["e1"]);

      await submit(sessionId, {
        summary: "the limit was lowered",
        timeline: [
          {
            at: "2026-07-03T01:40:00.000Z",
            what: "PR #482 merged",
            evidenceId: "tu-invented",
          },
          {
            at: "2026-07-03T02:00:00.000Z",
            what: "first kill",
            evidenceId: "",
          },
        ],
        recommendation: "revert it",
      });

      const timeline = (await getRecord(sessionId))!.report!.timeline;
      expect(timeline).toHaveLength(2);
      expect(timeline[0]!.what).toBe("PR #482 merged");
      expect(timeline[0]!.evidenceId).toBeUndefined();
      expect(timeline[1]!.evidenceId).toBeUndefined();
    });

    /* The lane describes the moment, not the call behind it, so an id that names
       nothing costs the row its citation and never its strand. */
    it("keeps a row's lane when its citation is dropped", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["e1"]);

      await submit(sessionId, {
        headline: "PR #482 raised the memory floor and web-01 was OOM-killed",
        affected: "web-01",
        summary: "the limit was lowered",
        timeline: [
          {
            at: "2026-07-03T01:40:00.000Z",
            what: "PR #482 merged",
            lane: "change",
            evidenceId: "tu-invented",
          },
        ],
        recommendation: "revert it",
      });

      const submitted = (await getRecord(sessionId))!.report!;
      expect(submitted.headline).toBe(
        "PR #482 raised the memory floor and web-01 was OOM-killed",
      );
      expect(submitted.affected).toBe("web-01");
      expect(submitted.timeline[0]!.lane).toBe("change");
      expect(submitted.timeline[0]!.evidenceId).toBeUndefined();
    });

    /* Refused rather than stored as "none": a report claiming a headline and a
       recommendation it does not have reads as complete downstream. */
    it("refuses a blank in a field the schema declares required", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["e1"]);

      const refused = await submit(sessionId, {
        headline: "   ",
        summary: "the limit was lowered",
        timeline: [],
      });

      expect(refused.isError).toBe(true);
      expect(String(refused.content)).toContain("headline");
      expect((await getRecord(sessionId))?.report ?? null).toBeNull();
    });

    it("stores every field once they are all filled in", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["e1"]);

      await submit(sessionId, {
        summary: "the limit was lowered",
        timeline: [],
      });

      const submitted = (await getRecord(sessionId))!.report!;
      expect(submitted.headline).toBe("the cache bump raised the memory floor");
      expect(submitted.affected).toBe("web-01");
      expect(submitted.summary).toBe("the limit was lowered");
    });

    // One more attempt is all it gets, so "invalid input" would tell it nothing.
    it("names the field that failed rather than refusing the whole call blindly", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);

      const refused = await submit(sessionId, {
        summary: "",
        timeline: [],
        recommendation: "",
      });

      expect(refused.isError).toBe(true);
      expect(String(refused.content)).toContain("summary");
      expect((await getRecord(sessionId))?.report ?? null).toBeNull();
    });
  });

  describe("evidence and conviction", () => {
    it("resolves a citation to the call that produced it, quoting the result verbatim", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["e1"]);
      // The timeline cites too, so a call named only there still resolves.
      await submit(sessionId, {
        summary: "the cache bump raised the floor",
        timeline: [
          {
            at: "2026-07-03T02:01:00.000Z",
            what: "PR #482 merged",
            evidenceId: "e2",
          },
        ],
        recommendation: "revert PR #482",
      });

      const evidence = await resolveEvidence(
        sessionId,
        (await getRecord(sessionId))!,
      );
      expect(evidence.map((e) => e.toolCallId)).toEqual(["tu-1", "tu-2"]);
      expect(evidence[0]).toMatchObject({
        toolName: "QueryMetricsRange",
        input: { query: "rss" },
      });
      // Verbatim: the result carries no tag to strip, so what the tool returned
      // is what the report quotes and what the model was shown.
      expect(JSON.parse(evidence[0]!.result)).toMatchObject({
        resultType: "matrix",
      });
      expect(JSON.parse(evidence[1]!.result)).toMatchObject({
        pullRequests: [{ number: 482 }],
      });
    });

    it("grades a claim by what backs it, not by what the model said", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);

      const one = await record(sessionId, "one source", "trigger", ["e1"]);
      const two = await record(sessionId, "two sources", "root_cause", [
        "e1",
        "e2",
      ]);
      const conviction = await computeConviction(
        sessionId,
        (await getRecord(sessionId))!,
      );
      expect(conviction[one]).toBe("cited");
      expect(conviction[two]).toBe("corroborated");
    });

    // The provider's own call id never appears as content, which is why one run
    // invented 21 ids rather than copy a real one.
    it("puts each call's citation handle in its own result, and takes it back", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);

      const { content } = await call("RecordHypothesis", sessionId, {
        statement: "the disk filled",
        verdict: "root_cause",
        finding: "the read showed 98 percent",
        // e1 is the first call the seeded transcript holds, which is tu-1.
        evidenceIds: ["e1"],
      });
      expect(String(content)).toContain("Recorded h1");

      // Stored as the handle it was cited by, so the record speaks one
      // vocabulary and nothing has to translate on the way back out.
      const [hypothesis] = (await getRecord(sessionId))!.hypotheses;
      expect(hypothesis?.evidenceIds).toEqual(["e1"]);

      // And it resolves to real evidence rather than a dangling reference.
      const resolved = await resolveEvidence(
        sessionId,
        (await getRecord(sessionId))!,
      );
      expect(resolved.map((e) => e.toolCallId)).toEqual(["tu-1"]);
    });

    /* The id a result carries is the id the record resolves that call by, and a
       tool no claim may rest on carries none, so three calls leave two citable. */
    it("numbers a citable result, and leaves a recording call unnumbered", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);

      const stored = await record(
        sessionId,
        "the disk filled",
        "root_cause",
        ["e1"],
        "the read showed 98 percent",
      );
      expect((await getRecord(sessionId))!.hypotheses[0]!.evidenceIds).toEqual([
        "e1",
      ]);

      // Two recording calls are on the transcript by now and neither took a
      // number, so the range the refusal offers still ends at e2.
      const refused = await call("RecordHypothesis", sessionId, {
        statement: "the volume is undersized",
        verdict: "root_cause",
        finding: "guessed",
        evidenceIds: ["e3"],
      });
      expect(String(refused.content)).toContain("e1 through e2");
      expect((await getRecord(sessionId))!.hypotheses).toHaveLength(1);
      expect(stored).toBe("h1");
    });

    // Counted from the transcript, the only thing that can answer it, so a
    // fifth restart at 3am is reported rather than slipped past.
    it("tells a card how often this same write already ran here", async () => {
      const sessionId = randomUUID();
      await seedAlertSession(
        { sessionId, title: "t", createdAt: new Date().toISOString() },
        [alert("prior-runs")],
      );
      const restart = (toolCallId: string, target: string) => ({
        toolCallId,
        name: "RestartDockerService",
        input: { target, reason: "r" },
      });
      await appendCall(
        sessionId,
        0,
        restart("tu-1", "prod-1/web/api"),
        "ok",
        "T1",
        undefined,
        true,
      );
      await appendCall(
        sessionId,
        2,
        restart("tu-2", "prod-1/web/api"),
        "ok",
        "T2",
        undefined,
        true,
      );
      // A different service, so it must not add to the count above.
      await appendCall(
        sessionId,
        4,
        restart("tu-3", "prod-1/web/cache"),
        "ok",
        "T3",
        undefined,
        true,
      );
      await appendCall(
        sessionId,
        6,
        restart("tu-4", "prod-1/web/api"),
        "ok",
        "T4",
        undefined,
        true,
      );

      const cards = (await buildTranscript(sessionId)).flatMap((item) =>
        item.kind === "tool_call" ? [item] : [],
      );
      const priorOf = (toolCallId: string): number | undefined =>
        cards.find((c) => c.toolCallId === toolCallId)?.priorRuns;

      // Counted in transcript order, so a card reports what ran before it and
      // never counts itself.
      expect(priorOf("tu-1")).toBeUndefined();
      expect(priorOf("tu-2")).toBe(1);
      expect(priorOf("tu-3")).toBeUndefined();
      expect(priorOf("tu-4")).toBe(2);
    });

    // Refused rather than stored with what survives. One run recorded three
    // identical uncited root causes when both were said in one breath.
    it("refuses a claim whose every citation names no call", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);

      const { content } = await call("RecordHypothesis", sessionId, {
        statement: "nothing behind it",
        verdict: "symptom",
        finding: "",
        evidenceIds: ["e9", "tu-invented"],
      });
      const answer = String(content);

      expect((await getRecord(sessionId))?.hypotheses ?? []).toHaveLength(0);
      expect(answer).toContain("Not recorded");
      expect(answer).toContain("e9");
      // Told what it could have cited, in the vocabulary it was given.
      expect(answer).toMatch(/e1 through e\d+/);
    });

    it("does not corroborate one source read twice", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await appendCall(
        sessionId,
        4,
        { toolCallId: "tu-3", name: "QueryMetrics", input: { query: "rss" } },
        "{}",
        "2026-07-03T02:02:00.000Z",
      );
      const id = await record(sessionId, "two metric queries", "root_cause", [
        "e1",
        "e3",
      ]);
      expect(
        (await computeConviction(sessionId, (await getRecord(sessionId))!))[id],
      ).toBe("cited");
    });

    // Which way the user went is recorded on the result, because nothing else
    // can say it: a refused call carries the same tool name as a released one.
    async function appendRestart(
      sessionId: string,
      seq: number,
      at: string,
      approved = true,
    ): Promise<void> {
      await appendCall(
        sessionId,
        seq,
        {
          toolCallId: "tu-restart",
          name: "RestartDockerService",
          input: { target: "prod-1/app/web" },
        },
        "restarted",
        at,
        undefined,
        approved,
      );
    }

    it("verifies a claim cited by a read taken after the write it released", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await appendRestart(sessionId, 4, "2026-07-03T02:05:00.000Z");
      // Dated after the write answered, which is what makes it a confirmation.
      await appendCall(
        sessionId,
        6,
        {
          toolCallId: "tu-after",
          name: "QueryMetricsRange",
          input: { query: "rss" },
        },
        METRICS,
        "2026-07-03T02:06:00.000Z",
      );

      const id = await record(
        sessionId,
        "the container needed a restart",
        "trigger",
        ["e4"],
      );
      expect(
        (await computeConviction(sessionId, (await getRecord(sessionId))!))[id],
      ).toBe("verified");
    });

    it("does not verify a claim cited only by reads taken before the write", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await appendRestart(sessionId, 4, "2026-07-03T02:05:00.000Z");

      const id = await record(
        sessionId,
        "the container needed a restart",
        "trigger",
        ["e1", "e2"],
      );
      expect(
        (await computeConviction(sessionId, (await getRecord(sessionId))!))[id],
      ).toBe("corroborated");
    });

    /* A model that cannot see it is looping would spend the whole budget asking
       for a tool that is not there. Only the clock used to stop it. */
    it("ends a run that spends three turns asking for tools it does not have", async () => {
      const barren = {
        toolUses: [
          { toolCallId: "tu-x", name: "GetK8sLogs", input: { target: "x" } },
        ],
        text: "",
      };
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          {
            ...barren,
            toolUses: [{ ...barren.toolUses[0]!, toolCallId: "tu-1" }],
          },
          {
            ...barren,
            toolUses: [{ ...barren.toolUses[0]!, toolCallId: "tu-2" }],
          },
          {
            ...barren,
            toolUses: [{ ...barren.toolUses[0]!, toolCallId: "tu-3" }],
          },
          // Never reached: the run ends on the third barren turn.
          { toolUses: [], text: "still going" },
        ]),
      );
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("barren"),
      ]);

      expect(await runSession({ sessionId, alerts: [alert("barren")] })).toBe(
        "completed",
      );

      const ended = (await getTranscriptRows(sessionId)).find(
        (row) => row.kind === "error",
      );
      expect(ended?.content).toContain("asked only for tools");
      // It says what it did have, so the ending is actionable rather than blunt.
      expect(ended?.content).toContain("RecordHypothesis");
    });

    // From a real run with no runner connected: GetK8sLogs exists and was
    // withheld, the rest were invented, and all three got one sentence.
    it("tells a withheld tool from an invented one, and names a near miss", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          {
            toolUses: [
              {
                toolCallId: "tu-withheld",
                name: "GetK8sLogs",
                input: { target: "x" },
              },
              { toolCallId: "tu-near", name: "RecordHypotheses", input: {} },
              { toolCallId: "tu-far", name: "SendSlackMessage", input: {} },
            ],
            text: "",
          },
          { toolUses: [], text: "Nothing I can reach." },
        ]),
      );
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("refusals"),
      ]);

      await runSession({ sessionId, alerts: [alert("refusals")] });

      const answerTo = async (toolCallId: string): Promise<string> => {
        const part = (await getTranscriptRows(sessionId))
          .flatMap((row) => row.parts)
          .find((p) => p.type === "tool_result" && p.toolCallId === toolCallId);
        return part !== undefined && part.type === "tool_result"
          ? part.output
          : "";
      };

      // A real tool the fleet cannot serve blames the connection, not the name.
      const withheld = await answerTo("tu-withheld");
      expect(withheld).toContain("is a real tool");
      expect(withheld).toContain("Kubernetes cluster");

      // An invented name close to a real one is pointed at it.
      const near = await answerTo("tu-near");
      expect(near).toContain("There is no tool called");
      expect(near).toContain("Did you mean RecordHypothesis?");

      /* One that resembles nothing on offer gets no suggestion. Naming an
         unrelated tool would send the model somewhere it was never going. */
      const far = await answerTo("tu-far");
      expect(far).toContain("There is no tool called");
      expect(far).not.toContain("Did you mean");

      // All three name what the turn held: a refusal that does not is a dead end.
      for (const message of [withheld, near, far]) {
        expect(message).toContain("What you do have:");
        expect(message).toContain("RecordHypothesis");
      }
    });

    // The record is built from what the turn did, so a failure reaches disk
    // without being read back out of a provider that cannot carry it.
    it("keeps a refused call's failure on the persisted result", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          {
            toolUses: [
              {
                toolCallId: "tu-gone",
                name: "GetK8sLogs",
                input: { target: "x" },
              },
            ],
            text: "",
          },
          { toolUses: [], text: "done" },
        ]),
      );
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("stamped"),
      ]);

      await runSession({ sessionId, alerts: [alert("stamped")] });

      // No Kubernetes runner is connected, so the tool is not in the offered
      // set and the turn answers with a refusal rather than a result.
      const answering = (await getTranscriptRows(sessionId))
        .flatMap((row) => row.parts)
        .find((p) => p.type === "tool_result" && p.toolCallId === "tu-gone");
      expect(answering).toMatchObject({ isError: true });
    });

    it("never counts a declined call as the write a later read confirms", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await appendRestart(sessionId, 4, "2026-07-03T02:05:00.000Z", false);
      await appendCall(
        sessionId,
        6,
        {
          toolCallId: "tu-after",
          name: "QueryMetricsRange",
          input: { query: "rss" },
        },
        METRICS,
        "2026-07-03T02:06:00.000Z",
      );

      const id = await record(
        sessionId,
        "the container needed a restart",
        "trigger",
        ["e4"],
      );
      // The user said no, so nothing changed and the read confirms nothing.
      expect(
        (await computeConviction(sessionId, (await getRecord(sessionId))!))[id],
      ).toBe("cited");
    });

    it("never counts an answered question as the write a later read confirms", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      // A question suspends the run for a human exactly as a write does, and
      // changes nothing, so it starts no clock a later reading can confirm.
      await appendCall(
        sessionId,
        4,
        {
          toolCallId: "tu-ask",
          name: "AskUserQuestion",
          input: { question: "Which deploy?", options: [] },
        },
        "the 14:02 one",
        "2026-07-03T02:05:00.000Z",
      );
      await appendCall(
        sessionId,
        6,
        {
          toolCallId: "tu-after",
          name: "QueryMetricsRange",
          input: { query: "rss" },
        },
        METRICS,
        "2026-07-03T02:06:00.000Z",
      );

      const id = await record(
        sessionId,
        "the deploy regressed memory",
        "trigger",
        ["e3"],
      );
      expect(
        (await computeConviction(sessionId, (await getRecord(sessionId))!))[id],
      ).toBe("cited");
      // Nor is it a decision the user made about a write.
      expect(await gatedCalls(sessionId)).toHaveLength(0);
    });

    // A refused call still carries the name of a gated tool, which is all the
    // old check looked at: five refusals read as five approved writes.
    it("never counts a call the harness refused as a write the user released", async () => {
      const sessionId = randomUUID();
      await seedTranscript(sessionId);
      await appendCall(
        sessionId,
        4,
        {
          toolCallId: "tu-refused",
          name: "DockerExec",
          input: { target: "prod-1/app/web", executable: "df", args: ["-h"] },
        },
        'Tool "DockerExec" is not available in this investigation.',
        "2026-07-03T02:05:00.000Z",
        true,
      );
      await appendCall(
        sessionId,
        6,
        {
          toolCallId: "tu-after",
          name: "QueryMetricsRange",
          input: { query: "rss" },
        },
        METRICS,
        "2026-07-03T02:06:00.000Z",
      );

      // Nobody was asked, so there is nothing to report either way.
      expect(await gatedCalls(sessionId)).toHaveLength(0);

      // A refusal counted as a released write made every later reading a
      // confirmation of it, grading a claim `verified` when nothing ran.
      const id = await record(
        sessionId,
        "the container is out of disk",
        "root_cause",
        ["e3"],
      );
      expect(
        (await computeConviction(sessionId, (await getRecord(sessionId))!))[id],
      ).toBe("cited");
    });
  });

  describe("the finish gate", () => {
    // Only the harness's own turns: on a resume the opening turn is an
    // appendUserMessage too, and these assertions are about what it said.
    function harnessMessages(index = 0): string[] {
      const provider = mockCreateProvider.mock.results[index]!.value as {
        appendUserMessage: ReturnType<typeof vi.fn>;
      };
      return provider.appendUserMessage.mock.calls.map(([msg]) => String(msg));
    }
    // Matched on content, not the first character: the <harness> tag is
    // asserted on its own below rather than by each of these.
    function recordGapsMessages(index = 0): string[] {
      return harnessMessages(index).filter((m) =>
        m.includes("Your investigation record"),
      );
    }
    function reportRequests(index = 0): string[] {
      return harnessMessages(index).filter((m) =>
        m.includes("Your investigation is over"),
      );
    }

    /* Two turns, because a call is only read on the turn after the one that made
       it. The read fails with no runner connected, which still answers. */
    function recordTurn(verdict: string, statement: string) {
      const n = randomUUID();
      return [
        {
          toolUses: [
            {
              toolCallId: `tu-read-${n}`,
              name: "GetDockerLogs",
              input: { target: "host/app/web" },
            },
          ],
          text: "",
        },
        {
          toolUses: [
            {
              toolCallId: `tu-record-${n}`,
              name: "RecordHypothesis",
              input: {
                statement,
                verdict,
                finding: "what the read showed",
                // e1 either way: the read above is the first citable call when
                // nothing precedes it, and one of them when something does.
                evidenceIds: ["e1"],
              },
            },
          ],
          text: "",
        },
      ];
    }

    function submitTurn(recommendation = "cap concurrency at one job") {
      return {
        toolUses: [
          {
            toolCallId: "tu-submit",
            name: "SubmitInvestigationReport",
            input: {
              headline: "the worker exhausted its memory limit",
              affected: "the worker",
              summary: "the worker ran out of memory",
              timeline: [],
              impact: "one job dropped",
              recommendation,
            },
          },
        ],
        text: "",
      };
    }

    // A harness turn is sent in the user's role, so it is tagged: untagged, the
    // model apologises to the person for something nobody said.
    it("marks every message it writes as its own, never as the user's", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          ...recordTurn("root_cause", "the disk filled up"),
          { toolUses: [], text: "Done." },
          submitTurn(),
        ]),
      );
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("tagged"),
      ]);

      await runSession({ sessionId, alerts: [alert("tagged")] });

      const written = harnessMessages();
      expect(written.length).toBeGreaterThan(0);
      for (const message of written) {
        expect(message.startsWith("<harness>")).toBe(true);
        expect(message.endsWith("</harness>")).toBe(true);
      }
    });

    it("asks a run that recorded nothing for the record, then writes up anyway", async () => {
      // Every turn is a free-form finish; the gate should push back
      // MAX_FINISH_PUSHBACKS times before giving up and composing from what there is.
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([{ toolUses: [], text: "All done." }]),
      );
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("gate"),
      ]);
      const toolOutcome = await runSession({
        sessionId,
        alerts: [alert("gate")],
      });
      expect(toolOutcome).toBe("completed");

      const requests = recordGapsMessages();
      expect(requests).toHaveLength(5);
      expect(requests[0]).toContain("recorded nothing");
      // The opening turn plus one per pushback, then every report attempt - the
      // scripted model never calls the tool, so the run ends with no report.
      const provider = mockCreateProvider.mock.results[0]!.value as {
        chat: ReturnType<typeof vi.fn>;
      };
      expect(provider.chat).toHaveBeenCalledTimes(11);
      expect(await getRecord(sessionId)).toBeUndefined();

      // Neither the requests nor the alert briefing NightWarden opened with is
      // drawn: the user sees one conversation, with the agent.
      const drawn = JSON.stringify(await buildTranscript(sessionId));
      expect(drawn).not.toContain("Your investigation record");
      expect(drawn).not.toContain("Your investigation is over");
      expect(drawn).not.toContain("<alert>");
    });

    /* Refused where the claim is made rather than at the finish line, because by
       the time the gate runs the turn that could fix it is over. */
    it("refuses a claim citing a call that has not answered", async () => {
      const sessionId = randomUUID();
      await seedAlertSession(
        { sessionId, title: "t", createdAt: new Date().toISOString() },
        [alert("unresolvable")],
      );
      await appendCitableRows([
        {
          sessionId,
          seq: 0,
          kind: "assistant",
          content: "[tool: QueryMetricsRange]",
          parts: [
            {
              type: "tool_call",
              toolCallId: "tu-silent",
              name: "QueryMetricsRange",
              input: { query: "rss" },
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ]);

      const refused = await call("RecordHypothesis", sessionId, {
        statement: "leak",
        verdict: "root_cause",
        finding: "rss climbed",
        evidenceIds: ["e1"],
      });

      // Named as not-yet rather than as invented: the fix is to wait for it,
      // not to go and find a different id.
      expect(String(refused.content)).toContain("has not answered yet");
      expect(String(refused.content)).not.toContain("no call you made");
      expect(await getRecord(sessionId)).toBeUndefined();

      // Once the call answers, the same claim records against it.
      await appendCitableRows([
        {
          sessionId,
          seq: await getNextSeq(sessionId),
          kind: "user",
          content: "result",
          parts: [
            {
              type: "tool_result",
              toolCallId: "tu-silent",
              output: "rss 700MB",
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ]);
      await call("RecordHypothesis", sessionId, {
        statement: "leak",
        verdict: "root_cause",
        finding: "rss climbed",
        evidenceIds: ["e1"],
      });
      expect((await getRecord(sessionId))!.hypotheses).toHaveLength(1);
      expect(await recordGaps(sessionId, 0)).toEqual([]);
    });

    // The largest single output of the run, so the ceiling is where it most
    // often dies - and dying into a server log says nothing on screen.
    it("says the report was cut off rather than ending with nothing", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          ...recordTurn("root_cause", "the disk filled up"),
          { toolUses: [], text: "I am done." },
          { toolUses: [], text: "", stopReason: "max_tokens" },
        ]),
      );
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("cut-off"),
      ]);

      const toolOutcome = await runSession({
        sessionId,
        alerts: [alert("cut-off")],
      });
      expect(toolOutcome).toBe("completed");

      const drawn = JSON.stringify(await buildTranscript(sessionId));
      expect(drawn).toContain("cut off at this model's output limit");
      expect(drawn).toContain("Your findings below are complete.");
      // The record survives the failure: it is the half worth keeping.
      expect((await getRecord(sessionId))!.hypotheses).toHaveLength(1);
      expect((await getRecord(sessionId))!.report).toBeNull();

      /* One report turn, not two: the same request against the same ceiling
         truncates identically, so a retry only writes a second failure. */
      const provider = mockCreateProvider.mock.results[0]!.value as {
        chat: ReturnType<typeof vi.fn>;
      };
      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(reportRequests()).toHaveLength(1);
    });

    // A follow-up writes over the same column, so the request carries what it
    // replaces: without it the model rewrites from a possibly compacted context.
    it("shows a second run the report it is replacing, as its own prior work", async () => {
      mockCreateProvider
        .mockImplementationOnce(() =>
          createContractFakeProvider([
            ...recordTurn("root_cause", "the disk filled up"),
            { toolUses: [], text: "I am done." },
            submitTurn("free up the disk"),
          ]),
        )
        .mockImplementationOnce(() =>
          createContractFakeProvider([
            ...recordTurn("root_cause", "the volume is undersized"),
            { toolUses: [], text: "Still full." },
            submitTurn("add a volume"),
          ]),
        );
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("revise"),
      ]);

      await runSession({ sessionId, alerts: [alert("revise")] });
      // The first run has nothing to revise, so it is shown nothing.
      expect(reportRequests()[0]).not.toContain("previous-report");

      await runSession({
        sessionId,
        seed: await buildSeed(sessionId),
        userMessage: "is it fixed?",
      });

      const second = harnessMessages(1).find((m) =>
        m.includes("previous-report"),
      );
      expect(second).toBeDefined();
      // Its own work, named as such, with the text it is replacing.
      expect(second).toContain("You wrote this at the end of your last run");
      expect(second).toContain("free up the disk");
      expect((await getRecord(sessionId))!.report).toMatchObject({
        recommendation: "add a volume",
      });
    });

    // Composing is lossy: the request says anything left out is lost, so a run
    // with nothing new must not recompose a write-up that was already right.
    it("keeps the write-up when a follow-up settles nothing new", async () => {
      mockCreateProvider
        .mockImplementationOnce(() =>
          createContractFakeProvider([
            ...recordTurn("root_cause", "the disk filled up"),
            { toolUses: [], text: "I am done." },
            submitTurn("free up the disk"),
          ]),
        )
        .mockImplementationOnce(() =>
          createContractFakeProvider([
            { toolUses: [], text: "Nothing has changed." },
          ]),
        );
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("unchanged"),
      ]);

      await runSession({ sessionId, alerts: [alert("unchanged")] });
      await runSession({
        sessionId,
        seed: await buildSeed(sessionId),
        userMessage: "anything else?",
      });

      // The second run never reached its report turn, and the write-up the
      // first one composed is still the one on the record.
      expect(reportRequests(1)).toHaveLength(0);
      expect((await getRecord(sessionId))!.report).toMatchObject({
        recommendation: "free up the disk",
      });
    });

    /* Coverage is stamped by the write that stores the report, so a failed turn
       leaves the last good one standing and the next run sees the gap. */
    it("rewrites for a follow-up run whose own write-up was refused", async () => {
      mockCreateProvider
        .mockImplementationOnce(() =>
          createContractFakeProvider([
            ...recordTurn("root_cause", "the disk filled up"),
            { toolUses: [], text: "I am done." },
            submitTurn("free up the disk"),
          ]),
        )
        // Records a second claim, then malforms every submission it is asked for.
        .mockImplementationOnce(() =>
          createContractFakeProvider([
            ...recordTurn("root_cause", "the volume is undersized"),
            { toolUses: [], text: "Still full." },
            ...Array.from({ length: 5 }, () => ({
              toolUses: [
                {
                  toolCallId: `bad-${randomUUID()}`,
                  name: "SubmitInvestigationReport" as const,
                  input: { headline: "" },
                },
              ],
              text: "",
            })),
          ]),
        )
        .mockImplementationOnce(() =>
          createContractFakeProvider([
            { toolUses: [], text: "Writing it up." },
            submitTurn("add a volume"),
          ]),
        );
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("refused-writeup"),
      ]);

      await runSession({ sessionId, alerts: [alert("refused-writeup")] });
      await runSession({
        sessionId,
        seed: await buildSeed(sessionId),
        userMessage: "is it fixed?",
      });

      // The second run's claim is on the record and its write-up never landed,
      // so the stamp still names the first run's.
      expect((await getRecord(sessionId))!.report).toMatchObject({
        recommendation: "free up the disk",
        hypothesesCoveredUpTo: "h1",
      });

      await runSession({
        sessionId,
        seed: await buildSeed(sessionId),
        userMessage: "and now?",
      });

      // A third run is told it is behind rather than keeping a write-up that
      // never accounted for h2.
      expect((await getRecord(sessionId))!.report).toMatchObject({
        recommendation: "add a volume",
        hypothesesCoveredUpTo: "h2",
      });
    });

    // A released write puts the write-up behind even when no claim moved: the
    // report renders what ran, so it would otherwise omit it.
    it("rewrites for a run that released a write and settled nothing new", async () => {
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("write-only"),
      ]);
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          ...recordTurn("root_cause", "the pool was exhausted"),
          { toolUses: [], text: "Done." },
          submitTurn("raise the pool"),
        ]),
      );
      await runSession({ sessionId, alerts: [alert("write-only")] });

      const before = (await getRecord(sessionId))!.report!;
      expect(before.writesCoveredUpTo).toBe(0);
      expect(
        reportIsBehind(
          (await getRecord(sessionId))!,
          before.writesCoveredUpTo + 1,
        ),
      ).toBe(true);
      expect(reportIsBehind((await getRecord(sessionId))!, 0)).toBe(false);
    });

    /* Asked over calls that answered and questioned the system: a refused call
       taught the run nothing, and recording is not reading. */
    describe("the record check", () => {
      async function connectRunner() {
        const runnerId = (await generateRunnerToken("docker", "rc-host")).id;
        const conn = registerRunner({
          runnerId,
          platform: "docker",
          serverName: "rc-host",
          send: (raw: string) => {
            const msg = JSON.parse(raw) as {
              payload: { correlationId: string };
            };
            resolveCommand({
              correlationId: msg.payload.correlationId,
              success: true,
              result: [],
            });
          },
          close: () => {},
        });
        setRunnerManifest(runnerId, manifest("rc-host"));
        return conn;
      }

      // Two answering calls a turn, so the count crosses 8 on the fourth.
      function readTurn() {
        return {
          toolUses: [
            { toolCallId: randomUUID(), name: "ListDockerServices", input: {} },
            { toolCallId: randomUUID(), name: "ListDockerServices", input: {} },
          ],
          text: "",
        };
      }

      function checks(index = 0): string[] {
        return harnessMessages(index).filter((m) =>
          m.includes("since your last recorded claim"),
        );
      }

      it("asks when reads pile up with nothing recorded over them", async () => {
        const conn = await connectRunner();
        mockCreateProvider.mockImplementationOnce(() =>
          createContractFakeProvider([
            readTurn(),
            readTurn(),
            readTurn(),
            readTurn(),
            ...recordTurn("root_cause", "the worker leaks"),
            { toolUses: [], text: "Done." },
            submitTurn(),
          ]),
        );
        const sessionId = randomUUID();
        await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
          alert("record-check"),
        ]);

        await runSession({ sessionId, alerts: [alert("record-check")] });

        expect(checks()).toHaveLength(1);
        expect(checks()[0]).toContain("answered 8 tool calls");
        unregisterRunner(conn);
      });

      /* Below the check's threshold, so nothing asks mid-run - but the reads
         still stand unaccounted for when the model says it is done. */
      it("asks at the finish gate for reads the check never reached", async () => {
        const conn = await connectRunner();
        mockCreateProvider.mockImplementationOnce(() =>
          createContractFakeProvider([
            ...recordTurn("root_cause", "the worker leaks"),
            readTurn(),
            { toolUses: [], text: "Done." },
            ...recordTurn("disproven", "the disk was fine"),
            { toolUses: [], text: "Done." },
            submitTurn(),
          ]),
        );
        const sessionId = randomUUID();
        await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
          alert("gate-tail"),
        ]);

        await runSession({ sessionId, alerts: [alert("gate-tail")] });

        // Two reads, under the eight the check waits for, so only the gate spoke.
        expect(checks()).toHaveLength(0);
        const asked = recordGapsMessages().filter((m) =>
          m.includes("Nothing on the record accounts for"),
        );
        expect(asked).toHaveLength(1);
        expect(asked[0]).toContain("the 2 tool calls you answered");
        // Answering it with a claim is what lets the run finish.
        expect((await getRecord(sessionId))!.hypotheses).toHaveLength(2);
        unregisterRunner(conn);
      });

      // Recording once buys no exemption: the debt is what has been read since
      // the last claim, so a run that settles early and reads on is asked again.
      it("asks a run that recorded early and then kept reading", async () => {
        const conn = await connectRunner();
        mockCreateProvider.mockImplementationOnce(() =>
          createContractFakeProvider([
            ...recordTurn("disproven", "the disk filled"),
            readTurn(),
            readTurn(),
            readTurn(),
            readTurn(),
            { toolUses: [], text: "Done." },
            submitTurn(),
          ]),
        );
        const sessionId = randomUUID();
        await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
          alert("record-check-quiet"),
        ]);

        await runSession({ sessionId, alerts: [alert("record-check-quiet")] });

        expect(checks()).toHaveLength(1);
        unregisterRunner(conn);
      });

      // Asking clears the question, never the debt the gate reads.
      it("holds the debt the check asked about against the finish gate", async () => {
        const conn = await connectRunner();
        mockCreateProvider.mockImplementationOnce(() =>
          createContractFakeProvider([
            ...recordTurn("disproven", "the disk filled"),
            readTurn(),
            readTurn(),
            readTurn(),
            readTurn(),
            { toolUses: [], text: "Done." },
            ...recordTurn("symptom", "the cache stayed cold"),
            { toolUses: [], text: "Done." },
            submitTurn(),
          ]),
        );
        const sessionId = randomUUID();
        await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
          alert("check-then-gate"),
        ]);

        await runSession({ sessionId, alerts: [alert("check-then-gate")] });

        // Asked once mid-run, at eight, and not again one read later.
        expect(checks()).toHaveLength(1);
        const asked = recordGapsMessages().filter((m) =>
          m.includes("Nothing on the record accounts for"),
        );
        expect(asked).toHaveLength(1);
        expect(asked[0]).toContain("the 8 tool calls you answered");
        // The claim that answered the gate is what let the run write up.
        expect((await getRecord(sessionId))!.hypotheses).toHaveLength(2);
        expect((await getRecord(sessionId))!.report).not.toBeNull();
        unregisterRunner(conn);
      });
    });

    it("writes the report on a second entry, without speaking as the user", async () => {
      mockCreateProvider
        .mockImplementationOnce(() =>
          createContractFakeProvider([
            ...recordTurn("root_cause", "the disk filled up"),
            { toolUses: [], text: "I am done." },
            { toolUses: [], text: "", stopReason: "max_tokens" },
          ]),
        )
        .mockImplementationOnce(() =>
          createContractFakeProvider([
            { toolUses: [], text: "" },
            submitTurn("free up the disk"),
          ]),
        );
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("retry"),
      ]);

      await runSession({ sessionId, alerts: [alert("retry")] });
      expect((await getRecord(sessionId))!.report).toBeNull();

      await runSession({
        sessionId,
        seed: await buildSeed(sessionId),
        harnessMessage: REPORT_RETRY_REQUEST,
      });

      expect((await getRecord(sessionId))!.report).toMatchObject({
        recommendation: "free up the disk",
      });
      const drawn = JSON.stringify(await buildTranscript(sessionId));
      expect(drawn).not.toContain("Your investigation is over and its record");
    });

    it("passes silently once the record holds a settled claim, then writes up", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          ...recordTurn("disproven", "the disk filled up"),
          { toolUses: [], text: "I could not determine a cause." },
          submitTurn("watch the disk for another day"),
        ]),
      );
      const sessionId = randomUUID();
      await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("gate-pass"),
      ]);
      const toolOutcome = await runSession({
        sessionId,
        alerts: [alert("gate-pass")],
      });
      expect(toolOutcome).toBe("completed");

      expect(recordGapsMessages()).toHaveLength(0);
      expect(reportRequests()).toHaveLength(1);
      // The record rides the request, so the timeline can copy ids from nearby.
      expect(reportRequests()[0]).toContain("RECORDED FINDINGS");
      expect(reportRequests()[0]).toContain("the disk filled up");

      const written = (await getRecord(sessionId))!;
      expect(written.hypotheses[0]!.verdict).toBe("disproven");
      expect(written.report).toMatchObject({
        summary: "the worker ran out of memory",
        recommendation: "watch the disk for another day",
      });
    });

    it("does not write up a chat, which keeps no record at all", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          { toolUses: [], text: "Nine containers." },
        ]),
      );
      const sessionId = randomUUID();
      await seedChatSession(sessionId, "how many containers are running?");
      const toolOutcome = await runSession({
        sessionId,
        userMessage: "how many containers are running?",
      });
      expect(toolOutcome).toBe("completed");
      expect(harnessMessages()).toHaveLength(0);
      expect(await getRecord(sessionId)).toBeUndefined();
    });

    // Ruling things out is a complete ending; releasing a write and then going
    // quiet with the condition still firing is not.
    describe("a run that acted", () => {
      // A write the user was asked about and let through, recorded on the call
      // where it happened. Nothing about the tool's name could say this.
      async function releasedWrite(
        sessionId: string,
        seq: number,
      ): Promise<void> {
        await appendCall(
          sessionId,
          seq,
          {
            toolCallId: "tu-released",
            name: "RestartDockerService",
            input: { target: "prod-1/app/web" },
          },
          "restarted",
          "2026-07-03T02:05:00.000Z",
          undefined,
          true,
        );
      }

      function settledRun(...extra: ReturnType<typeof submitTurn>[]) {
        mockCreateProvider.mockImplementationOnce(() =>
          createContractFakeProvider([
            ...recordTurn("disproven", "the worker leaks"),
            { toolUses: [], text: "Restarted it." },
            ...extra,
          ]),
        );
      }

      it("is asked for a recommendation when nothing can confirm recovery", async () => {
        settledRun();
        const sessionId = randomUUID();
        await seedAlertSession(
          { sessionId, title: "t", createdAt: new Date().toISOString() },
          [alert("acted-firing")],
        );
        await releasedWrite(sessionId, 0);

        await seedAlertSession(
          buildSessionMeta(sessionId, null, undefined),

          [alert("acted-firing")],
        );

        await runSession({ sessionId, alerts: [alert("acted-firing")] });

        const request = reportRequests()[0]!;
        // Never "try again": repeating a write that did not work is the failure
        // this gate exists to catch.
        expect(request).not.toContain("try again");
        expect(request).toContain("Nothing can confirm");
      });

      // The refusal names the field, while the request that follows says only
      // that the report is unwritten, which is true either way.
      it("refuses a write-up that recommends nothing, and asks again", async () => {
        settledRun(submitTurn(""), submitTurn("cap concurrency at one job"));
        const sessionId = randomUUID();
        await seedAlertSession(
          { sessionId, title: "t", createdAt: new Date().toISOString() },
          [alert("acted-no-recommendation")],
        );
        await releasedWrite(sessionId, 0);

        await seedAlertSession(
          buildSessionMeta(sessionId, null, undefined),

          [alert("acted-no-recommendation")],
        );

        await runSession({
          sessionId,
          alerts: [alert("acted-no-recommendation")],
        });

        const retries = harnessMessages().filter((m) =>
          m.includes("The report was refused"),
        );
        expect(retries).toHaveLength(1);
        expect((await getRecord(sessionId))!.report!.recommendation).toBe(
          "cap concurrency at one job",
        );
      });

      it("says nothing about recovery to a run that only looked", async () => {
        settledRun();
        const sessionId = randomUUID();
        await seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
          alert("only-looked"),
        ]);
        await runSession({ sessionId, alerts: [alert("only-looked")] });

        // No write was released, so an ending that names no cause stands even
        // though the alert never cleared.
        expect(recordGapsMessages()).toHaveLength(0);
        const request = reportRequests()[0]!;
        expect(request).not.toContain("is still firing");
        expect(request).not.toContain("Nothing can confirm");
      });
    });
  });
});
