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
import { runInvestigation } from "../agent/loop.js";
import {
  computeConviction,
  reportGaps,
  resolveEvidence,
} from "../agent/report.js";
import { REPORT_TOOLS } from "../agent/tools/report.js";
import { executeTool } from "../agent/tools/toolset.js";
import { getReport } from "../db/reports.js";
import { recordToolOutcome } from "../db/tool-outcomes.js";
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
        createdAt: at,
      },
      {
        sessionId,
        seq: seq + 1,
        kind: "user",
        content: "results",
        parts: [{ type: "tool_result", toolCallId: entry.id, output }],
        createdAt: at,
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

  // Records the hypothesis and returns the id the system assigned to it.
  async function propose(
    sessionId: string,
    statement: string,
  ): Promise<string> {
    await call("ProposeHypothesis", sessionId, { statement });
    const hypotheses = getReport(sessionId)!.hypotheses;
    return hypotheses[hypotheses.length - 1]!.id;
  }

  describe("hypothesis transitions", () => {
    it("records proposing and resolving as two acts on one row", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);

      const id = await propose(sessionId, "the cache bump leaks");
      expect(getReport(sessionId)!.hypotheses).toMatchObject([
        {
          id,
          statement: "the cache bump leaks",
          verdict: "open",
          resolvedAt: null,
        },
      ]);

      await call("ResolveHypothesis", sessionId, {
        id,
        verdict: "root_cause",
        finding: "the climb starts at the merge",
        evidenceIds: ["tu-1"],
      });
      const resolved = getReport(sessionId)!.hypotheses[0]!;
      expect(resolved).toMatchObject({
        id,
        statement: "the cache bump leaks",
        verdict: "root_cause",
        finding: "the climb starts at the merge",
        evidenceIds: ["tu-1"],
      });
      expect(resolved.resolvedAt).not.toBeNull();
    });

    it("expresses all six verdicts, five settled and one still being tested", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const settled = [
        "root_cause",
        "trigger",
        "symptom",
        "contributing_factor",
        "disproven",
      ];
      for (const verdict of settled) {
        const id = await propose(sessionId, `about ${verdict}`);
        await call("ResolveHypothesis", sessionId, {
          id,
          verdict,
          finding: "",
          evidenceIds: ["tu-1"],
        });
      }
      await propose(sessionId, "still being tested");
      expect(getReport(sessionId)!.hypotheses.map((h) => h.verdict)).toEqual([
        ...settled,
        "open",
      ]);
    });

    it("refuses a verdict of open, which is where a hypothesis starts", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const id = await propose(sessionId, "the cache bump leaks");
      const result = await call("ResolveHypothesis", sessionId, {
        id,
        verdict: "open",
        finding: "",
        evidenceIds: ["tu-1"],
      });
      expect(result.outcome).toBe("system");
    });

    it("refuses to alter a hypothesis a later call disagrees with", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const id = await propose(sessionId, "the cache bump leaks");
      await call("ResolveHypothesis", sessionId, {
        id,
        verdict: "root_cause",
        finding: "first read",
        evidenceIds: ["tu-1"],
      });

      const second = await call("ResolveHypothesis", sessionId, {
        id,
        verdict: "disproven",
        finding: "changed my mind",
        evidenceIds: ["tu-2"],
      });
      expect(second.outcome).toBe("expected_miss");
      expect(String(second.content)).toMatch(/already resolved/);

      // The row the model tried to overwrite is untouched, and nothing is gone.
      expect(getReport(sessionId)!.hypotheses).toHaveLength(1);
      expect(getReport(sessionId)!.hypotheses[0]).toMatchObject({
        verdict: "root_cause",
        finding: "first read",
      });
    });

    it("refuses a verdict on a hypothesis that was never proposed", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const result = await call("ResolveHypothesis", sessionId, {
        id: "h9",
        verdict: "root_cause",
        finding: "",
        evidenceIds: ["tu-1"],
      });
      expect(result.outcome).toBe("expected_miss");
      expect(getReport(sessionId)).toBeUndefined();
    });

    it("refuses a verdict with nothing behind it", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const id = await propose(sessionId, "the cache bump leaks");
      const result = await call("ResolveHypothesis", sessionId, {
        id,
        verdict: "root_cause",
        finding: "a hunch",
        evidenceIds: [],
      });
      expect(result.outcome).toBe("system");
      expect(getReport(sessionId)!.hypotheses[0]!.verdict).toBe("open");
    });

    it("keeps a claim whose citation resolves to nothing, and drops only the citation", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const id = await propose(sessionId, "the cache bump leaks");
      await call("ResolveHypothesis", sessionId, {
        id,
        verdict: "root_cause",
        finding: "the climb starts at the merge",
        evidenceIds: ["tu-1", "tu-invented"],
      });

      // The overreach is visible as a missing citation, never as a missing claim.
      const stored = getReport(sessionId)!.hypotheses[0]!;
      expect(stored.statement).toBe("the cache bump leaks");
      expect(stored.evidenceIds).toEqual(["tu-1"]);
    });
  });

  describe("the proposed fix", () => {
    it("keeps a superseded fix beside the one that replaced it", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await call("ProposeFix", sessionId, {
        summary: "revert PR #482",
        evidenceIds: ["tu-2", "tu-invented"],
      });
      expect(getReport(sessionId)!.fixes).toMatchObject([
        { id: "f1", summary: "revert PR #482", evidenceIds: ["tu-2"] },
      ]);

      // A rejected fix redirects the agent, so it proposes again; the first
      // stays on the record and the last one is what stands.
      await call("ProposeFix", sessionId, {
        summary: "restart the container instead",
        evidenceIds: [],
      });
      expect(getReport(sessionId)!.fixes.map((f) => f.summary)).toEqual([
        "revert PR #482",
        "restart the container instead",
      ]);
    });
  });

  describe("evidence and conviction", () => {
    it("resolves a citation to the call that produced it, quoting the result verbatim", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      const id = await propose(sessionId, "the cache bump leaks");
      await call("ResolveHypothesis", sessionId, {
        id,
        verdict: "root_cause",
        finding: "",
        evidenceIds: ["tu-1"],
      });
      await call("ProposeFix", sessionId, {
        summary: "revert PR #482",
        evidenceIds: ["tu-2"],
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

      const one = await propose(sessionId, "one source");
      await call("ResolveHypothesis", sessionId, {
        id: one,
        verdict: "trigger",
        finding: "",
        evidenceIds: ["tu-1"],
      });
      const two = await propose(sessionId, "two sources");
      await call("ResolveHypothesis", sessionId, {
        id: two,
        verdict: "root_cause",
        finding: "",
        evidenceIds: ["tu-1", "tu-2"],
      });
      const none = await propose(sessionId, "nothing behind it");
      await call("ResolveHypothesis", sessionId, {
        id: none,
        verdict: "symptom",
        finding: "",
        evidenceIds: ["tu-invented"],
      });

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
      const id = await propose(sessionId, "two metric queries");
      await call("ResolveHypothesis", sessionId, {
        id,
        verdict: "root_cause",
        finding: "",
        evidenceIds: ["tu-1", "tu-3"],
      });
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

    it("verifies a fix cited by a read taken after the write it released", async () => {
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

      await call("ProposeFix", sessionId, {
        summary: "restart the container",
        evidenceIds: ["tu-after"],
      });
      expect(computeConviction(sessionId, getReport(sessionId)!)["f1"]).toBe(
        "verified",
      );
    });

    it("does not verify a fix cited only by reads taken before the write", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      appendRestart(sessionId, 4, "2026-07-03T02:05:00.000Z");

      await call("ProposeFix", sessionId, {
        summary: "restart the container",
        evidenceIds: ["tu-1", "tu-2"],
      });
      expect(computeConviction(sessionId, getReport(sessionId)!)["f1"]).toBe(
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

      await call("ProposeFix", sessionId, {
        summary: "restart the container",
        evidenceIds: ["tu-after"],
      });
      // The operator said no, so nothing changed and the read confirms nothing.
      expect(computeConviction(sessionId, getReport(sessionId)!)["f1"]).toBe(
        "cited",
      );
    });
  });

  describe("the finish gate", () => {
    // Only the requests: the opening turn is an appendUserMessage too on the
    // paths that resume, and the assertions below are about what the gate said.
    function completionRequests(index = 0): string[] {
      const provider = mockCreateProvider.mock.results[index]!.value as {
        appendUserMessage: ReturnType<typeof vi.fn>;
      };
      return provider.appendUserMessage.mock.calls
        .map(([msg]) => String(msg))
        .filter((msg) => msg.startsWith("Your investigation record"));
    }

    it("asks a run that recorded nothing for the record, then lets it end", async () => {
      // Every turn is a free-form finish; the gate should push back MAX_NUDGES
      // times before letting the run go.
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([{ toolUses: [], text: "All done." }]),
      );
      const sessionId = randomUUID();
      const outcome = await runInvestigation({
        sessionId,
        alerts: [alert("gate")],
      });
      expect(outcome).toBe("completed");

      const requests = completionRequests();
      expect(requests).toHaveLength(3);
      expect(requests[0]).toContain("recorded no hypotheses");
      const provider = mockCreateProvider.mock.results[0]!.value as {
        chat: ReturnType<typeof vi.fn>;
      };
      expect(provider.chat).toHaveBeenCalledTimes(4);
      expect(getReport(sessionId)).toBeUndefined();

      // Neither the requests nor the alert briefing NightWarden opened with is
      // drawn: the operator sees one conversation, with the agent.
      const drawn = JSON.stringify(buildTranscript(sessionId));
      expect(drawn).not.toContain("Your investigation record");
      expect(drawn).not.toContain("<alert>");
    });

    it("names only the gap that remains, not the whole contract", async () => {
      // One hypothesis proposed and never settled: the record has exactly one
      // hole, and the request must not mention the four it does not have.
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          {
            toolUses: [
              {
                id: "tu-propose",
                name: "ProposeHypothesis",
                input: { statement: "the disk filled up" },
              },
            ],
            text: "",
          },
          { toolUses: [], text: "That is my answer." },
        ]),
      );
      const sessionId = randomUUID();
      await runInvestigation({ sessionId, alerts: [alert("one-gap")] });

      const request = completionRequests()[0]!;
      expect(request).toContain("h1 is still open");
      expect(request).toContain("ResolveHypothesis");
      expect(request).not.toContain("recorded no hypotheses");
      expect(request).not.toContain("ProposeFix");
    });

    it("counts a claim backed only by a call that never answered as a gap", async () => {
      const sessionId = randomUUID();
      createSession(
        { sessionId, title: "t", createdAt: new Date().toISOString() },
        [alert("unresolvable")],
      );
      // The call is in the transcript, so the citation is not fabricated - but
      // it never answered, so there is nothing to quote under the claim.
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
          createdAt: new Date().toISOString(),
        },
      ]);
      await call("ProposeHypothesis", sessionId, { statement: "leak" });
      await call("ResolveHypothesis", sessionId, {
        id: "h1",
        verdict: "root_cause",
        finding: "rss climbed",
        evidenceIds: ["tu-silent"],
      });

      const gaps = reportGaps(sessionId);
      expect(gaps.map((g) => g.kind)).toEqual(["unresolvable_citation"]);
    });

    it("passes silently once every hypothesis is settled", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          {
            toolUses: [
              {
                id: "tu-propose",
                name: "ProposeHypothesis",
                input: { statement: "the disk filled up" },
              },
            ],
            text: "",
          },
          {
            toolUses: [
              {
                id: "tu-resolve",
                name: "ResolveHypothesis",
                input: {
                  id: "h1",
                  verdict: "disproven",
                  finding: "the disk was at 12 per cent",
                  evidenceIds: ["tu-propose"],
                },
              },
            ],
            text: "",
          },
          { toolUses: [], text: "I could not determine a cause." },
        ]),
      );
      const sessionId = randomUUID();
      const outcome = await runInvestigation({
        sessionId,
        alerts: [alert("gate-pass")],
      });
      expect(outcome).toBe("completed");

      expect(completionRequests()).toHaveLength(0);
      const provider = mockCreateProvider.mock.results[0]!.value as {
        chat: ReturnType<typeof vi.fn>;
      };
      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(getReport(sessionId)!.hypotheses[0]!.verdict).toBe("disproven");
    });

    /* The gate holds a run that acted to a different standard from one that only
       looked. "I could not work out the cause" is a complete ending; releasing a
       write and then going quiet with the condition still firing is not. */
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

      function settledRun(): void {
        mockCreateProvider.mockImplementationOnce(() =>
          createContractFakeProvider([
            {
              toolUses: [
                {
                  id: "tu-propose",
                  name: "ProposeHypothesis",
                  input: { statement: "the worker leaks" },
                },
              ],
              text: "",
            },
            {
              toolUses: [
                {
                  id: "tu-resolve",
                  name: "ResolveHypothesis",
                  input: {
                    id: "h1",
                    verdict: "disproven",
                    finding: "it did not",
                    evidenceIds: ["tu-propose"],
                  },
                },
              ],
              text: "",
            },
            { toolUses: [], text: "Restarted it." },
          ]),
        );
      }

      it("is asked for a recommendation when the condition still fires", async () => {
        settledRun();
        const sessionId = randomUUID();
        createSession(
          { sessionId, title: "t", createdAt: new Date().toISOString() },
          [alert("acted-firing")],
        );
        releasedWrite(sessionId, 0);

        await runInvestigation({ sessionId, alerts: [alert("acted-firing")] });

        const requests = completionRequests();
        expect(requests[0]).toContain("still firing");
        expect(requests[0]).toContain("ProposeFix");
        // Never "try again": repeating a write that did not work is the failure
        // this gate exists to catch.
        expect(requests[0]).not.toContain("try again");
      });

      it("is let go once it has recommended something", async () => {
        mockCreateProvider.mockImplementationOnce(() =>
          createContractFakeProvider([
            {
              toolUses: [
                {
                  id: "tu-fix",
                  name: "ProposeFix",
                  input: { summary: "cap concurrency", evidenceIds: [] },
                },
              ],
              text: "",
            },
            { toolUses: [], text: "Recommended." },
          ]),
        );
        const sessionId = randomUUID();
        createSession(
          { sessionId, title: "t", createdAt: new Date().toISOString() },
          [alert("acted-recommended")],
        );
        releasedWrite(sessionId, 0);

        await runInvestigation({
          sessionId,
          alerts: [alert("acted-recommended")],
        });

        // The record has an empty-record gap of its own; what must not appear is
        // the recovery sentence, because the operator has been told what to do.
        expect(completionRequests().join(" ")).not.toContain("still firing");
      });

      it("says nothing to a run that only looked", async () => {
        settledRun();
        const sessionId = randomUUID();
        await runInvestigation({ sessionId, alerts: [alert("only-looked")] });

        // No write was released, so an honest inconclusive ending stands even
        // though the alert never cleared.
        expect(completionRequests()).toHaveLength(0);
      });
    });
  });
});
