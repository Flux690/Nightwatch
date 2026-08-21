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

import type {
  HumanDecision,
  NormalizedAlert,
  ToolOutcome,
} from "@nightwarden/shared";
import { runSession } from "../agent/loop.js";
import {
  computeConviction,
  gatedCalls,
  reportGaps,
  resolveEvidence,
} from "../agent/report.js";
import { REPORT_TOOLS, SUBMIT_REPORT_TOOL } from "../agent/tools/report.js";
import { REPORT_RETRY_REQUEST } from "../agent/prompts/report.js";
import { buildSeed } from "../session/seed.js";
import { executeTool } from "../agent/tools/toolset.js";
import { getReport } from "../db/reports.js";
import { appendTranscriptRows, getTranscriptRows } from "../db/sessions.js";
import { buildSessionMeta } from "../agent/loop.js";
import { seedAlertSession, seedChatSession } from "./session-helper.js";
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
    values: {},
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

  // One ledger entry at a chosen instant, so a read after a remediation is
  // distinguishable from one before. `outcome` rides the part, as production does.
  function appendCall(
    sessionId: string,
    seq: number,
    entry: { id: string; name: string; input: Record<string, unknown> },
    output: string,
    at: string,
    outcome?: ToolOutcome,
    humanDecision?: HumanDecision,
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
        parts: [
          {
            type: "tool_result",
            toolCallId: entry.id,
            output,
            ...(outcome !== undefined && { outcome }),
            ...(humanDecision !== undefined && { humanDecision }),
          },
        ],
        timestamp: at,
      },
    ]);
  }

  // tu-1 a Prometheus range query, tu-2 a GitHub change list: two sources, so
  // citing both is corroboration and citing either alone is not.
  function seedTranscript(sessionId: string): void {
    seedAlertSession(
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

  // The report turn's tool, which is never in the toolset: the loop
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
        // The one rule broken most often, so the refusal says what to do about
        // it rather than only which field failed.
        expect(String(result.content)).toContain("at least one citation");
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

  describe("the written report", () => {
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
      // The ledger it was written from is untouched by the writing.
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

    /* The lane describes the moment, not the call behind it, so an id that names
       nothing costs the row its citation and never its strand. */
    it("keeps a row's lane when its citation is dropped", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["tu-1"]);

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
        impact: "",
        recommendation: "revert it",
      });

      const submitted = getReport(sessionId)!.submitted!;
      expect(submitted.headline).toBe(
        "PR #482 raised the memory floor and web-01 was OOM-killed",
      );
      expect(submitted.affected).toBe("web-01");
      expect(submitted.timeline[0]!.lane).toBe("change");
      expect(submitted.timeline[0]!.evidenceId).toBeUndefined();
    });

    /* A field left out is a thinner report, not a broken one: failing the call
       would throw away the fields the model did fill in. A field that is present
       and blank means "none", which is how the wire schema says optional. */
    it("stores a report that omits the optional prose, and reads a blank as none", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      await record(sessionId, "the cache bump leaks", "root_cause", ["tu-1"]);

      await submit(sessionId, {
        headline: "   ",
        summary: "the limit was lowered",
        timeline: [],
        impact: "",
        recommendation: "revert it",
      });

      const submitted = getReport(sessionId)!.submitted!;
      expect(submitted.headline).toBeUndefined();
      expect(submitted.affected).toBeUndefined();
      expect(submitted.summary).toBe("the limit was lowered");
    });

    // One more attempt is all it gets, so "invalid input" would tell it nothing.
    it("names the field that failed rather than refusing the whole call blindly", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);

      const refused = await submit(sessionId, {
        summary: "",
        timeline: [],
        impact: "",
        recommendation: "",
      });

      expect(refused.outcome).toBe("system");
      expect(String(refused.content)).toContain("summary");
      expect(getReport(sessionId)?.submitted ?? null).toBeNull();
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
    // from the ledger: a gated call that answered is one the user released.
    /* A gated write the user was asked about. Which way they went is recorded on
       the result, because nothing else can say it: the tool's name is the same
       whether a person released the call or the harness refused to offer it. */
    function appendRestart(
      sessionId: string,
      seq: number,
      at: string,
      humanDecision: HumanDecision = "approved",
    ): void {
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
        undefined,
        humanDecision,
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

    /* From a real run with no runner connected. GetK8sLogs exists and was
       withheld; the rest were invented. They all got the same sentence, so the
       model worked through the namespace guessing which, and 28 of that run's
       39 calls were refusals nothing counted. */
    it("tells a withheld tool from an invented one, and names a near miss", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          {
            toolUses: [
              { id: "tu-withheld", name: "GetK8sLogs", input: { target: "x" } },
              { id: "tu-near", name: "RecordHypotheses", input: {} },
              { id: "tu-far", name: "K8sExec", input: { command: "ls" } },
            ],
            text: "",
          },
          { toolUses: [], text: "Nothing I can reach." },
        ]),
      );
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("refusals"),
      ]);

      await runSession({ sessionId, alerts: [alert("refusals")] });

      const answerTo = (toolUseId: string): string => {
        const part = getTranscriptRows(sessionId)
          .flatMap((row) => row.parts)
          .find((p) => p.type === "tool_result" && p.toolCallId === toolUseId);
        return part !== undefined && part.type === "tool_result"
          ? part.output
          : "";
      };

      // A real tool the fleet cannot serve blames the connection, not the name.
      const withheld = answerTo("tu-withheld");
      expect(withheld).toContain("is a real tool");
      expect(withheld).toContain("Kubernetes cluster");

      // An invented name close to a real one is pointed at it.
      const near = answerTo("tu-near");
      expect(near).toContain("There is no tool called");
      expect(near).toContain("Did you mean RecordHypothesis?");

      /* One that resembles nothing on offer gets no suggestion. Naming an
         unrelated tool would send the model somewhere it was never going. */
      const far = answerTo("tu-far");
      expect(far).toContain("There is no tool called");
      expect(far).not.toContain("Did you mean");

      // All three name what the turn held, which the old sentence never did.
      for (const message of [withheld, near, far]) {
        expect(message).toContain("What you do have is:");
        expect(message).toContain("RecordHypothesis");
      }
    });

    // A provider carries the wire's error flag and nothing else, so the class is
    // put back on the way to disk. Without it a reload cannot tell miss from crash.
    it("keeps the outcome class on the persisted result, not beside it", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          {
            toolUses: [
              { id: "tu-gone", name: "GetK8sLogs", input: { target: "x" } },
            ],
            text: "",
          },
          { toolUses: [], text: "done" },
        ]),
      );
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("stamped"),
      ]);

      await runSession({ sessionId, alerts: [alert("stamped")] });

      // No Kubernetes runner is connected, so the tool is not in the offered
      // set and the turn answers with a class rather than a result.
      const answering = getTranscriptRows(sessionId)
        .flatMap((row) => row.parts)
        .find((p) => p.type === "tool_result" && p.toolCallId === "tu-gone");
      expect(answering).toMatchObject({ outcome: "system", isError: true });
    });

    it("never counts a declined call as the write a later read confirms", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      appendRestart(sessionId, 4, "2026-07-03T02:05:00.000Z", "rejected");
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
      // The user said no, so nothing changed and the read confirms nothing.
      expect(computeConviction(sessionId, getReport(sessionId)!)[id]).toBe(
        "cited",
      );
    });

    it("never counts an answered question as the write a later read confirms", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      // A question suspends the run for a human exactly as a write does, and
      // changes nothing, so it starts no clock a later reading can confirm.
      appendCall(
        sessionId,
        4,
        {
          id: "tu-ask",
          name: "AskUserQuestion",
          input: { question: "Which deploy?", options: [] },
        },
        "the 14:02 one",
        "2026-07-03T02:05:00.000Z",
      );
      appendCall(
        sessionId,
        6,
        { id: "tu-after", name: "QueryMetricsRange", input: { query: "rss" } },
        METRICS,
        "2026-07-03T02:06:00.000Z",
      );

      const id = await record(
        sessionId,
        "the deploy regressed memory",
        "trigger",
        ["tu-after"],
      );
      expect(computeConviction(sessionId, getReport(sessionId)!)[id]).toBe(
        "cited",
      );
      // Nor is it a decision the user made about a write.
      expect(gatedCalls(sessionId)).toHaveLength(0);
    });

    /* The defect this record was built to end. With no Docker runner connected,
       DockerBash is not in the offered set, so the harness answers the call
       itself and no card is ever drawn. It still carries the name of a gated
       tool, which is all the old check looked at - so five refusals were
       reported to the user as five writes they had approved, and fed to the
       report turn under a heading saying so. */
    it("never counts a call the harness refused as a write the user released", async () => {
      const sessionId = randomUUID();
      seedTranscript(sessionId);
      appendCall(
        sessionId,
        4,
        {
          id: "tu-refused",
          name: "DockerBash",
          input: { target: "docker/app/web", command: "df -h" },
        },
        'Tool "DockerBash" is not available in this investigation.',
        "2026-07-03T02:05:00.000Z",
        "system",
      );
      appendCall(
        sessionId,
        6,
        { id: "tu-after", name: "QueryMetricsRange", input: { query: "rss" } },
        METRICS,
        "2026-07-03T02:06:00.000Z",
      );

      // Nobody was asked, so there is nothing to report either way.
      expect(gatedCalls(sessionId)).toHaveLength(0);

      /* And it starts no clock. A refusal that counted as a released write made
         every later reading a confirmation of it, so a claim citing one graded
         `verified` - the tier that means an action ran and was checked. */
      const id = await record(
        sessionId,
        "the container is out of disk",
        "root_cause",
        ["tu-after"],
      );
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
    function reportRequests(index = 0): string[] {
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

    it("asks a run that recorded nothing for the record, then writes up anyway", async () => {
      // Every turn is a free-form finish; the gate should push back MAX_NUDGES
      // times before giving up and composing from what there is.
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([{ toolUses: [], text: "All done." }]),
      );
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("gate"),
      ]);
      const outcome = await runSession({
        sessionId,
        alerts: [alert("gate")],
      });
      expect(outcome).toBe("completed");

      const requests = completionRequests();
      expect(requests).toHaveLength(3);
      expect(requests[0]).toContain("recorded nothing");
      // Four investigating turns, then both report attempts - the scripted
      // model never calls the tool, so the run ends with no report at all.
      const provider = mockCreateProvider.mock.results[0]!.value as {
        chat: ReturnType<typeof vi.fn>;
      };
      expect(provider.chat).toHaveBeenCalledTimes(6);
      expect(getReport(sessionId)).toBeUndefined();

      // Neither the requests nor the alert briefing NightWarden opened with is
      // drawn: the user sees one conversation, with the agent.
      const drawn = JSON.stringify(buildTranscript(sessionId));
      expect(drawn).not.toContain("Your investigation record");
      expect(drawn).not.toContain("Your investigation is over");
      expect(drawn).not.toContain("<alert>");
    });

    it("names only the gap that remains, not the whole contract", async () => {
      const sessionId = randomUUID();
      seedAlertSession(
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
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("one-gap"),
      ]);
      await runSession({ sessionId, alerts: [alert("one-gap")] });

      const request = completionRequests()[0]!;
      expect(request).toContain(
        "h1 is backed only by calls that returned nothing",
      );
      expect(request).not.toContain("recorded nothing");
    });

    it("counts a claim backed only by a call that never answered as a gap", async () => {
      const sessionId = randomUUID();
      seedAlertSession(
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

    /* The largest single output of the run, with thinking spending the budget
       first, so the output ceiling is where it most often dies. It used to die
       into a server log, leaving no write-up and nothing saying why. */
    it("says the report was cut off rather than ending with nothing", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          recordTurn("root_cause", "the disk filled up"),
          { toolUses: [], text: "I am done." },
          { toolUses: [], text: "", stopReason: "max_tokens" },
        ]),
      );
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("cut-off"),
      ]);

      const outcome = await runSession({
        sessionId,
        alerts: [alert("cut-off")],
      });
      expect(outcome).toBe("completed");

      const drawn = JSON.stringify(buildTranscript(sessionId));
      expect(drawn).toContain("cut off at this model's output limit");
      expect(drawn).toContain("Your findings below are complete.");
      // The ledger survives the failure: it is the half worth keeping.
      expect(getReport(sessionId)!.hypotheses).toHaveLength(1);
      expect(getReport(sessionId)!.submitted).toBeNull();

      /* One report turn, not two. The same request against the same ceiling
         truncates identically, so a second attempt only writes a second failure
         for the reader to scroll past. */
      const provider = mockCreateProvider.mock.results[0]!.value as {
        chat: ReturnType<typeof vi.fn>;
      };
      expect(provider.chat).toHaveBeenCalledTimes(3);
      expect(reportRequests()).toHaveLength(1);
    });

    /* The same loop entered again, not a second way to make a report. The
       sentence that re-enters is NightWarden's, so a reader who pressed a button
       is never shown words in their own voice that they did not write. */
    it("writes the report on a second entry, without speaking as the user", async () => {
      mockCreateProvider
        .mockImplementationOnce(() =>
          createContractFakeProvider([
            recordTurn("root_cause", "the disk filled up"),
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
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("retry"),
      ]);

      await runSession({ sessionId, alerts: [alert("retry")] });
      expect(getReport(sessionId)!.submitted).toBeNull();

      await runSession({
        sessionId,
        seed: buildSeed(sessionId),
        harnessMessage: REPORT_RETRY_REQUEST,
      });

      expect(getReport(sessionId)!.submitted).toMatchObject({
        recommendation: "free up the disk",
      });
      const drawn = JSON.stringify(buildTranscript(sessionId));
      expect(drawn).not.toContain("Your investigation is over and its record");
    });

    it("passes silently once the ledger holds a settled claim, then writes up", async () => {
      mockCreateProvider.mockImplementationOnce(() =>
        createContractFakeProvider([
          recordTurn("disproven", "the disk filled up"),
          { toolUses: [], text: "I could not determine a cause." },
          submitTurn("watch the disk for another day"),
        ]),
      );
      const sessionId = randomUUID();
      seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
        alert("gate-pass"),
      ]);
      const outcome = await runSession({
        sessionId,
        alerts: [alert("gate-pass")],
      });
      expect(outcome).toBe("completed");

      expect(completionRequests()).toHaveLength(0);
      expect(reportRequests()).toHaveLength(1);
      // The ledger rides the request, so the timeline can copy ids from nearby.
      expect(reportRequests()[0]).toContain("RECORDED FINDINGS");
      expect(reportRequests()[0]).toContain("the disk filled up");

      const report = getReport(sessionId)!;
      expect(report.hypotheses[0]!.verdict).toBe("disproven");
      expect(report.submitted).toMatchObject({
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
      seedChatSession(sessionId, "how many containers are running?");
      const outcome = await runSession({
        sessionId,
        userMessage: "how many containers are running?",
      });
      expect(outcome).toBe("completed");
      expect(harnessMessages()).toHaveLength(0);
      expect(getReport(sessionId)).toBeUndefined();
    });

    /* A run that acted is held to a different standard from one that only looked:
       "I could not work out the cause" is a complete ending, releasing a write
       and then going quiet with the condition still firing is not. */
    describe("a run that acted", () => {
      // A write the user was asked about and let through, recorded on the call
      // where it happened. Nothing about the tool's name could say this.
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
          undefined,
          "approved",
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
        seedAlertSession(
          { sessionId, title: "t", createdAt: new Date().toISOString() },
          [alert("acted-firing")],
        );
        releasedWrite(sessionId, 0);

        seedAlertSession(
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

      it("refuses a write-up that recommends nothing, and asks again", async () => {
        settledRun(submitTurn(""), submitTurn("cap concurrency at one job"));
        const sessionId = randomUUID();
        seedAlertSession(
          { sessionId, title: "t", createdAt: new Date().toISOString() },
          [alert("acted-no-recommendation")],
        );
        releasedWrite(sessionId, 0);

        seedAlertSession(
          buildSessionMeta(sessionId, null, undefined),

          [alert("acted-no-recommendation")],
        );

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
        seedAlertSession(buildSessionMeta(sessionId, null, undefined), [
          alert("only-looked"),
        ]);
        await runSession({ sessionId, alerts: [alert("only-looked")] });

        // No write was released, so an honest inconclusive ending stands even
        // though the alert never cleared.
        expect(completionRequests()).toHaveLength(0);
        const request = reportRequests()[0]!;
        expect(request).not.toContain("is still firing");
        expect(request).not.toContain("Nothing can confirm");
      });
    });
  });
});
