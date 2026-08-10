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

import type { NormalizedAlert } from "@nightwarden/shared";
import { runSession } from "../agent/loop.js";
import {
  computeConviction,
  reportGaps,
  resolveEvidence,
} from "../agent/report.js";
import { REPORT_TOOLS, SUBMIT_REPORT_TOOL } from "../agent/tools/report.js";
import { executeTool } from "../agent/tools/toolset.js";
import { getReport } from "../db/reports.js";
import { recordToolOutcome } from "../db/tool-outcomes.js";
import {
  deletePrometheusIntegration,
  savePrometheusIntegration,
} from "../db/integrations.js";
import { createSession, appendTranscriptRows } from "../db/sessions.js";
import { buildTranscript } from "../session/transcript.js";
import { useTempDb } from "./temp-db.js";

function alert(sourceAlertId: string): NormalizedAlert {
  return {
    sourceAlertId,
    labels: {},
    alertType: "HighMemory",
    severity: "warning",
    firedAt: new Date().toISOString(),
    annotations: {},
    generatorURL: null,
    rawPayload: {},
  };
}

describe("the investigation record", () => {
  let cleanupDb: () => void;

  beforeAll(() => {
    cleanupDb = useTempDb();
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

  // One ledger entry: the call and the result it answered with, at a chosen
  // instant so a read after a remediation is distinguishable from one before.
  function appendCall(
    sessionId: string,
    seq: number,
    entry: { id: string; name: string; input: Record<string, unknown> },
    output: string,
    at: string,
  ): void {
    appendTranscriptRows([
      {
        sessionId,
        seq,
        kind: "assistant",
        content: `[tool: ${entry.name}]`,
        parts: [
          {
            type: "tool_call",
            id: entry.id,
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
        parts: [{ type: "tool_result", toolCallId: entry.id, output }],
        timestamp: at,
      },
    ]);
  }

  // tu-1 a Prometheus range query, tu-2 a GitHub change list: two sources, so
  // citing both is corroboration and citing either alone is not.
  function seedTranscript(sessionId: string): void {
    createSession(
      { sessionId, title: "t", createdAt: new Date().toISOString() },
      [alert("seed")],
    );
    appendCall(
      sessionId,
      0,
      { id: "tu-1", name: "QueryMetricsRange", input: { query: "rss" } },
      METRICS,
      "2026-07-03T02:00:00.000Z",
    );
    appendCall(
      sessionId,
      2,
      { id: "tu-2", name: "GetRecentChanges", input: {} },
      CHANGES,
      "2026-07-03T02:01:00.000Z",
    );
  }

  async function call(
    toolName: string,
    sessionId: string,
    input: Record<string, unknown>,
  ): Promise<{ content: unknown; outcome?: string }> {
    const tool = REPORT_TOOLS.find((t) => t.schema.name === toolName);
    return executeTool(tool!, input, {
      sessionId,
      toolUseId: `tu-${toolName}`,
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
  ): Promise<string> {
    await call("RecordHypothesis", sessionId, {
      statement,
      verdict,
      finding,
      evidenceIds,
    });
    const hypotheses = getReport(sessionId)!.hypotheses;
    return hypotheses[hypotheses.length - 1]!.id;
  }

  // The composition turn's tool, which is never in the toolset: the loop
  // attaches it alone once the ledger gate has passed.
  async function submit(
    sessionId: string,
    input: Record<string, unknown>,
  ): Promise<{ content: unknown; outcome?: string }> {
    return executeTool(SUBMIT_REPORT_TOOL, input, {
      sessionId,
      toolUseId: "tu-submit",
      toolCallCeilingMs: 15_000,
    });
  }

  describe("recording a hypothesis", () => {
    it("records what was tested and how it settled as one act", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);

      const id = await record(
        sessionId,
        "the cache bump leaks",
        "root_cause",
        ["tu-1"],
        "the climb starts at the merge",
      );
      const stored = getReport(sessionId)!.hypotheses[0]!;
      expect(stored).toMatchObject({
        id,
        statement: "the cache bump leaks",
        verdict: "root_cause",
        finding: "the climb starts at the merge",
        evidenceIds: ["tu-1"],
      });
      expect(stored.recordedAt).not.toBe("");
    });

    it("expresses all five verdicts, every one of them settled", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const verdicts = [
        "root_cause",
        "trigger",
        "symptom",
        "contributing_factor",
        "disproven",
      ];
      for (const verdict of verdicts) {
        await record(sessionId, `about ${verdict}`, verdict, ["tu-1"]);
      }
      expect(getReport(sessionId)!.hypotheses.map((h) => h.verdict)).toEqual(
        verdicts,
      );
    });

    it("refuses a verdict that is not one of the five", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const result = await call("RecordHypothesis", sessionId, {
        statement: "the cache bump leaks",
        verdict: "open",
        finding: "still looking",
        evidenceIds: ["tu-1"],
      });
      expect(result.outcome).toBe("system");
      expect(getReport(sessionId)).toBeUndefined();
    });

    it("refuses a claim with nothing behind it, on any verdict", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      for (const verdict of ["root_cause", "disproven"]) {
        const result = await call("RecordHypothesis", sessionId, {
          statement: "a hunch",
          verdict,
          finding: "no reason given",
          evidenceIds: [],
        });
        expect(result.outcome).toBe("system");
      }
      expect(getReport(sessionId)).toBeUndefined();
    });

    /* Append-only: there is no call that rewrites a row, so a changed mind is a
       second record beside the first rather than an edit of it. */
    it("keeps a claim the run later disagreed with beside the one that replaced it", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["tu-1"]);
      await record(sessionId, "the cache bump leaks", "disproven", ["tu-2"]);

      expect(
        getReport(sessionId)!.hypotheses.map((h) => [h.id, h.verdict]),
      ).toEqual([
        ["h1", "root_cause"],
        ["h2", "disproven"],
      ]);
    });

    it("keeps a claim whose citation resolves to nothing, and drops only the citation", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", [
        "tu-1",
        "tu-invented",
      ]);

      // The overreach is visible as a missing citation, never as a missing claim.
      const stored = getReport(sessionId)!.hypotheses[0]!;
      expect(stored.statement).toBe("the cache bump leaks");
      expect(stored.evidenceIds).toEqual(["tu-1"]);
    });
  });

  describe("the composed report", () => {
    it("writes the prose the ledger has no field for, over a ledger it leaves alone", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["tu-1"]);

      await submit(sessionId, {
        summary:
          "web-01 was OOM-killed because the cache bump raised its floor",
        timeline: [
          {
            at: "2026-07-03T02:00:00.000Z",
            what: "memory crossed the limit",
            evidenceId: "tu-1",
          },
        ],
        impact: "nine minutes of failed reads",
        recommendation: "revert PR #482",
      });

      const report = getReport(sessionId)!;
      expect(report.submitted).toMatchObject({
        summary:
          "web-01 was OOM-killed because the cache bump raised its floor",
        impact: "nine minutes of failed reads",
        recommendation: "revert PR #482",
      });
      // The ledger it was composed from is untouched by the composing.
      expect(report.hypotheses).toHaveLength(1);
      expect(report.hypotheses[0]!.verdict).toBe("root_cause");
    });

    it("drops a timeline citation naming no call, and keeps the entry", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["tu-1"]);

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
        impact: "",
        recommendation: "revert it",
      });

      const timeline = getReport(sessionId)!.submitted!.timeline;
      expect(timeline).toHaveLength(2);
      expect(timeline[0]!.what).toBe("PR #482 merged");
      expect(timeline[0]!.evidenceId).toBeUndefined();
      expect(timeline[1]!.evidenceId).toBeUndefined();
    });
  });

  describe("evidence and conviction", () => {
    it("resolves a citation to the call that produced it, quoting the result verbatim", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["tu-1"]);
      // The timeline cites too, so a call named only there still resolves.
      await submit(sessionId, {
        summary: "the cache bump raised the floor",
        timeline: [
          {
            at: "2026-07-03T02:01:00.000Z",
            what: "PR #482 merged",
            evidenceId: "tu-2",
          },
        ],
        impact: "",
        recommendation: "revert PR #482",
      });

      const evidence = resolveEvidence(sessionId, getReport(sessionId)!);
      expect(evidence.map((e) => e.toolUseId)).toEqual(["tu-1", "tu-2"]);
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
      seedTranscript(sessionId);

      const one = await record(sessionId, "one source", "trigger", ["tu-1"]);
      const two = await record(sessionId, "two sources", "root_cause", [
        "tu-1",
        "tu-2",
      ]);
      const none = await record(sessionId, "nothing behind it", "symptom", [
        "tu-invented",
      ]);

      const conviction = computeConviction(sessionId, getReport(sessionId)!);
      expect(conviction[one]).toBe("cited");
      expect(conviction[two]).toBe("corroborated");
      expect(conviction[none]).toBeUndefined();
    });

    it("does not corroborate one source read twice", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      appendCall(
        sessionId,
        4,
        { id: "tu-3", name: "QueryMetrics", input: { query: "rss" } },
        "{}",
        "2026-07-03T02:02:00.000Z",
      );
      const id = await record(sessionId, "two metric queries", "root_cause", [
        "tu-1",
        "tu-3",
      ]);
      expect(computeConviction(sessionId, getReport(sessionId)!)[id]).toBe(
        "cited",
      );
    });

    // The clock a confirmation is measured against is the write itself, read
    // from the ledger: a gated call that answered is one the operator released.
    function appendRestart(sessionId: string, seq: number, at: string): void {
      appendCall(
        sessionId,
        seq,
        {
          id: "tu-restart",
          name: "RestartDockerService",
          input: { target: "docker/app/web" },
        },
        "restarted",
        at,
      );
    }

    it("verifies a claim cited by a read taken after the write it released", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      appendRestart(sessionId, 4, "2026-07-03T02:05:00.000Z");
      // Dated after the write answered, which is what makes it a confirmation.
      appendCall(
        sessionId,
        6,
        { id: "tu-after", name: "QueryMetricsRange", input: { query: "rss" } },
        METRICS,
        "2026-07-03T02:06:00.000Z",
      );

      const id = await record(
        sessionId,
        "the container needed a restart",
        "trigger",
        ["tu-after"],
      );
      expect(computeConviction(sessionId, getReport(sessionId)!)[id]).toBe(
        "verified",
      );
    });

    it("does not verify a claim cited only by reads taken before the write", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      appendRestart(sessionId, 4, "2026-07-03T02:05:00.000Z");

      const id = await record(
        sessionId,
        "the container needed a restart",
        "trigger",
        ["tu-1", "tu-2"],
      );
      expect(computeConviction(sessionId, getReport(sessionId)!)[id]).toBe(
        "corroborated",
      );
    });

    it("never counts a declined call as the write a later read confirms", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      appendRestart(sessionId, 4, "2026-07-03T02:05:00.000Z");
      recordToolOutcome(sessionId, "tu-restart", "rejected");
      appendCall(
        sessionId,
        6,
        { id: "tu-after", name: "QueryMetricsRange", input: { query: "rss" } },
        METRICS,
        "2026-07-03T02:06:00.000Z",
      );

      const id = await record(
        sessionId,
        "the container needed a restart",
        "trigger",
        ["tu-after"],
      );
      // The operator said no, so nothing changed and the read confirms nothing.
      expect(computeConviction(sessionId, getReport(sessionId)!)[id]).toBe(
        "cited",
      );
    });
  });

  describe("the finish gate", () => {
    // Only the harness's own turns: the opening turn is an appendUserMessage too
    // on the paths that resume, and the assertions below are about what the
    // harness said, split by which of its two jobs said it.
    function harnessMessages(index = 0): string[] {
      const provider = mockCreateProvider.mock.results[index]!.value as {
        appendUserMessage: ReturnType<typeof vi.fn>;
      };
      return provider.appendUserMessage.mock.calls.map(([msg]) => String(msg));
    }
    function completionRequests(index = 0): string[] {
      return harnessMessages(index).filter((m) =>
        m.startsWith("Your investigation record"),
      );
    }
    function compositionRequests(index = 0): string[] {
      return harnessMessages(index).filter((m) =>
        m.startsWith("Your investigation is over"),
      );
    }

    // A scripted turn recording one hypothesis, citing the recording call's own
    // id - which is in the ledger by then, because the assistant turn is
    // persisted before its tools run.
    function recordTurn(verdict: string, statement: string) {
      return {
        toolUses: [
          {
            id: "tu-record",
            name: "RecordHypothesis",
            input: {
              statement,
              verdict,
              finding: "what the read showed",
              evidenceIds: ["tu-record"],
            },
          },
        ],
        text: "",
      };
    }

    function submitTurn(recommendation = "cap concurrency at one job") {
      return {
        toolUses: [
          {
            id: "tu-submit",
            name: "SubmitInvestigationReport",
            input: {
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

    it("asks a run that recorded nothing for the record, then composes anyway", async () => {
      // Every turn is a free-form finish; the gate should push back MAX_NUDGES
      // times before giving up and composing from what there is.
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([{ toolUses: [], text: "All done." }]),
      );
      const sessionId = randomUUID();
      const outcome = await runSession({
        sessionId,
        alerts: [alert("gate")],
      });
      expect(outcome).toBe("completed");

      const requests = completionRequests();
      expect(requests).toHaveLength(3);
      expect(requests[0]).toContain("recorded nothing");
      // Four investigating turns, then both composition attempts - the scripted
      // model never calls the tool, so the run ends with no report at all.
      const provider = mockCreateProvider.mock.results[0]!.value as {
        chat: ReturnType<typeof vi.fn>;
      };
      expect(provider.chat).toHaveBeenCalledTimes(6);
      expect(getReport(sessionId)).toBeUndefined();

      // Neither the requests nor the alert briefing NightWarden opened with is
      // drawn: the operator sees one conversation, with the agent.
      const drawn = JSON.stringify(buildTranscript(sessionId));
      expect(drawn).not.toContain("Your investigation record");
      expect(drawn).not.toContain("Your investigation is over");
      expect(drawn).not.toContain("<alert>");
    });

    it("names only the gap that remains, not the whole contract", async () => {
      const sessionId = randomUUID();
      createSession(
        { sessionId, title: "t", createdAt: new Date().toISOString() },
        [alert("one-gap")],
      );
      // In the transcript, so the citation is not fabricated - but it never
      // answered, so there is nothing to quote under the claim.
      appendTranscriptRows([
        {
          sessionId,
          seq: 0,
          kind: "assistant",
          content: "[tool: QueryMetricsRange]",
          parts: [
            {
              type: "tool_call",
              id: "tu-silent",
              name: "QueryMetricsRange",
              input: { query: "rss" },
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ]);
      await call("RecordHypothesis", sessionId, {
        statement: "leak",
        verdict: "root_cause",
        finding: "rss climbed",
        evidenceIds: ["tu-silent"],
      });

      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          { toolUses: [], text: "That is my answer." },
        ]),
      );
      await runSession({ sessionId, alerts: [alert("one-gap")] });

      const request = completionRequests()[0]!;
      expect(request).toContain(
        "h1 is backed only by calls that returned nothing",
      );
      expect(request).not.toContain("recorded nothing");
    });

    it("counts a claim backed only by a call that never answered as a gap", async () => {
      const sessionId = randomUUID();
      createSession(
        { sessionId, title: "t", createdAt: new Date().toISOString() },
        [alert("unresolvable")],
      );
      appendTranscriptRows([
        {
          sessionId,
          seq: 0,
          kind: "assistant",
          content: "[tool: QueryMetricsRange]",
          parts: [
            {
              type: "tool_call",
              id: "tu-silent",
              name: "QueryMetricsRange",
              input: { query: "rss" },
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ]);
      await call("RecordHypothesis", sessionId, {
        statement: "leak",
        verdict: "root_cause",
        finding: "rss climbed",
        evidenceIds: ["tu-silent"],
      });

      const gaps = reportGaps(sessionId);
      expect(gaps.map((g) => g.kind)).toEqual(["unresolvable_citation"]);
    });

    it("passes silently once the ledger holds a settled claim, then composes", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          recordTurn("disproven", "the disk filled up"),
          { toolUses: [], text: "I could not determine a cause." },
          submitTurn("watch the disk for another day"),
        ]),
      );
      const sessionId = randomUUID();
      const outcome = await runSession({
        sessionId,
        alerts: [alert("gate-pass")],
      });
      expect(outcome).toBe("completed");

      expect(completionRequests()).toHaveLength(0);
      expect(compositionRequests()).toHaveLength(1);
      // The ledger rides the request, so the timeline can copy ids from nearby.
      expect(compositionRequests()[0]).toContain("RECORDED FINDINGS");
      expect(compositionRequests()[0]).toContain("the disk filled up");

      const report = getReport(sessionId)!;
      expect(report.hypotheses[0]!.verdict).toBe("disproven");
      expect(report.submitted).toMatchObject({
        summary: "the worker ran out of memory",
        recommendation: "watch the disk for another day",
      });
    });

    it("does not compose a chat, which keeps no record at all", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          { toolUses: [], text: "Nine containers." },
        ]),
      );
      const sessionId = randomUUID();
      const outcome = await runSession({
        sessionId,
        userMessage: "how many containers are running?",
      });
      expect(outcome).toBe("completed");
      expect(harnessMessages()).toHaveLength(0);
      expect(getReport(sessionId)).toBeUndefined();
    });

    /* The gate holds a run that acted to a different standard from one that only
       looked. "I could not work out the cause" is a complete ending; releasing a
       write and then going quiet with the condition still firing is not - and
       that demand lands on the composition turn, where the recommendation is
       written. */
    describe("a run that acted", () => {
      // A gated call carrying a result: the registry says it needed releasing,
      // and no rejected outcome on it says the operator released it.
      function releasedWrite(sessionId: string, seq: number): void {
        appendCall(
          sessionId,
          seq,
          {
            id: "tu-released",
            name: "RestartDockerService",
            input: { target: "docker/app/web" },
          },
          "restarted",
          "2026-07-03T02:05:00.000Z",
        );
      }

      function settledRun(...extra: ReturnType<typeof submitTurn>[]) {
        mockCreateProvider.mockImplementationOnce(() =>
          createContractFakeProvider([
            recordTurn("disproven", "the worker leaks"),
            { toolUses: [], text: "Restarted it." },
            ...extra,
          ]),
        );
      }

      it("is asked for a recommendation when nothing can confirm recovery", async () => {
        settledRun();
        const sessionId = randomUUID();
        createSession(
          { sessionId, title: "t", createdAt: new Date().toISOString() },
          [alert("acted-firing")],
        );
        releasedWrite(sessionId, 0);

        await runSession({ sessionId, alerts: [alert("acted-firing")] });

        const request = compositionRequests()[0]!;
        // Never "try again": repeating a write that did not work is the failure
        // this gate exists to catch.
        expect(request).not.toContain("try again");
        expect(request).toContain("Nothing can confirm");
      });

      it("refuses a write-up that recommends nothing, and asks again", async () => {
        settledRun(submitTurn(""), submitTurn("cap concurrency at one job"));
        const sessionId = randomUUID();
        createSession(
          { sessionId, title: "t", createdAt: new Date().toISOString() },
          [alert("acted-no-recommendation")],
        );
        releasedWrite(sessionId, 0);

        await runSession({
          sessionId,
          alerts: [alert("acted-no-recommendation")],
        });

        const retries = harnessMessages().filter((m) =>
          m.includes("recommends nothing"),
        );
        expect(retries).toHaveLength(1);
        expect(getReport(sessionId)!.submitted!.recommendation).toBe(
          "cap concurrency at one job",
        );
      });

      it("says nothing about recovery to a run that only looked", async () => {
        settledRun();
        const sessionId = randomUUID();
        await runSession({ sessionId, alerts: [alert("only-looked")] });

        // No write was released, so an honest inconclusive ending stands even
        // though the alert never cleared.
        expect(completionRequests()).toHaveLength(0);
        const request = compositionRequests()[0]!;
        expect(request).not.toContain("is still firing");
        expect(request).not.toContain("Nothing can confirm");
      });
    });
  });
});
