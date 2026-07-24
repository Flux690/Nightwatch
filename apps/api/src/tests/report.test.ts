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

import type { NormalizedAlert, Report } from "@nightwatch/shared";
import { runInvestigation } from "../agent/loop.js";
import { GATE_NUDGE } from "../agent/prompts/report.js";
import { finalizeInconclusive } from "../agent/report.js";
import { REPORT_TOOLS } from "../agent/tools/report.js";
import { executeTool } from "../agent/tools/toolset.js";
import { getReport, isReportComplete } from "../db/reports.js";
import { createSession, appendSessionMessages } from "../db/sessions.js";
import { useTempDb } from "./temp-db.js";

function alert(sourceAlertId: string): NormalizedAlert {
  return {
    sourceAlertId,
    labels: {},
    targetIdentifier: {
      provider: "docker",
      project: "web-01",
      service: "web-01",
    },
    alertType: "HighMemory",
    severity: "warning",
    firedAt: new Date().toISOString(),
    rawPayload: {},
  };
}

function baseReport(overrides: Partial<Report>): Report {
  return {
    status: "root_cause_identified",
    headline: "test",
    rootCause: { summary: "OOM", detail: "memory climbed" },
    hypotheses: [
      {
        id: "h1",
        statement: "leak",
        state: "root_cause",
        confidence: "high",
        reason: "rss climbed",
        evidenceIds: ["ev1"],
      },
    ],
    evidence: [
      {
        id: "ev1",
        toolUseId: "tu-1",
        toolName: "QueryMetricsRange",
        summary: "climb",
      },
    ],
    proposedFix: { summary: "restart", steps: [], evidenceIds: [] },
    updatedAt: new Date().toISOString(),
    model: "test",
    ...overrides,
  };
}

describe("isReportComplete", () => {
  it("rejects investigation_incomplete and accepts inconclusive", () => {
    expect(
      isReportComplete(baseReport({ status: "investigation_incomplete" })),
    ).toBe(false);
    expect(isReportComplete(baseReport({ status: "inconclusive" }))).toBe(true);
  });

  it("requires a summary, no open hypotheses, and an evidence-backed root cause", () => {
    expect(isReportComplete(baseReport({}))).toBe(true);
    expect(
      isReportComplete(
        baseReport({ rootCause: { summary: "  ", detail: "" } }),
      ),
    ).toBe(false);
    expect(
      isReportComplete(
        baseReport({
          hypotheses: [
            ...baseReport({}).hypotheses,
            {
              id: "h2",
              statement: "open one",
              state: "open",
              confidence: "low",
              reason: "",
              evidenceIds: [],
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isReportComplete(
        baseReport({
          hypotheses: [
            {
              id: "h1",
              statement: "leak",
              state: "root_cause",
              confidence: "high",
              reason: "",
              evidenceIds: [],
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("report storage and enrichment", () => {
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

  // Seeds a session whose transcript holds two tool calls: [evidence: e1] a
  // QueryMetricsRange and [evidence: e2] a GetRecentChanges, in Anthropic block shape.
  function seedTranscript(sessionId: string): void {
    createSession(
      { sessionId, title: "t", createdAt: new Date().toISOString() },
      alert("seed"),
    );
    const metrics = JSON.stringify({
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
    const changes = JSON.stringify({
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
    const now = new Date().toISOString();
    appendSessionMessages([
      {
        sessionId,
        seq: 0,
        role: "assistant",
        content: "[tool_use: QueryMetricsRange]",
        providerContent: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "QueryMetricsRange",
              input: { query: "container_memory_rss" },
            },
          ],
        },
        createdAt: now,
      },
      {
        sessionId,
        seq: 1,
        role: "user",
        content: "results",
        providerContent: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-1",
              content: `${metrics}\n\n[evidence: e1]`,
            },
          ],
        },
        createdAt: now,
      },
      {
        sessionId,
        seq: 2,
        role: "assistant",
        content: "[tool_use: GetRecentChanges]",
        providerContent: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-2",
              name: "GetRecentChanges",
              input: {},
            },
          ],
        },
        createdAt: now,
      },
      {
        sessionId,
        seq: 3,
        role: "user",
        content: "results",
        providerContent: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-2",
              content: `${changes}\n\n[evidence: e2]`,
            },
          ],
        },
        createdAt: now,
      },
    ]);
  }

  it("UpdateReport resolves citations, attaches snapshots, and drops unknown tags", async () => {
    const sessionId = randomUUID();
    seedTranscript(sessionId);

    const result = await executeTool(
      REPORT_TOOLS[0]!,
      {
        status: "root_cause_identified",
        headline: "web-01 memory leak",
        rootCause: { summary: "leak after PR #482", detail: "rss climbed" },
        hypotheses: [
          {
            id: "h1",
            statement: "cache bump leaks",
            state: "root_cause",
            confidence: "high",
            reason: "climb starts at merge",
            evidenceIds: ["ev1", "ev2", "ev-bogus"],
          },
        ],
        evidence: [
          { id: "ev1", evidenceTag: "e1", summary: "rss climbing" },
          { id: "ev2", evidenceTag: "e2", summary: "PR #482 merged" },
          { id: "ev-bogus", evidenceTag: "e99", summary: "phantom" },
        ],
        proposedFix: {
          summary: "revert PR #482",
          steps: ["revert", "deploy"],
          evidenceIds: ["ev2", "ev-bogus"],
        },
      },
      { sessionId, toolUseId: "tu-report", toolTimeoutMs: 15_000 },
    );
    expect(result.is_error).toBeUndefined();

    const report = getReport(sessionId)!;
    expect(report.status).toBe("root_cause_identified");
    // Unknown tag e99: the entry is dropped and every reference to it stripped.
    expect(report.evidence.map((e) => e.id)).toEqual(["ev1", "ev2"]);
    expect(report.hypotheses[0]!.evidenceIds).toEqual(["ev1", "ev2"]);
    expect(report.proposedFix.evidenceIds).toEqual(["ev2"]);
    // Citations resolved to real transcript tool calls.
    expect(report.evidence[0]).toMatchObject({
      toolUseId: "tu-1",
      toolName: "QueryMetricsRange",
    });
    expect(report.evidence[0]!.chartSnapshot).toMatchObject({
      seriesLabel: "container_memory_rss (web-01)",
    });
    expect(report.evidence[0]!.chartSnapshot!.points).toEqual([
      ["2024-07-03T09:46:40.000Z", 100],
      ["2024-07-03T09:47:40.000Z", 200],
    ]);
    expect(report.evidence[1]!.changesSnapshot!.pullRequests[0]).toMatchObject({
      number: 482,
      url: "https://github.com/o/r/pull/482",
    });
    expect(isReportComplete(report)).toBe(true);
  });

  it("finalizeInconclusive stamps an existing report and creates a minimal one when absent", () => {
    const existingId = randomUUID();
    seedTranscript(existingId);
    finalizeInconclusive(existingId, "test-model");
    const fresh = getReport(existingId)!;
    expect(fresh.status).toBe("inconclusive");

    const missingId = randomUUID();
    finalizeInconclusive(missingId, "test-model");
    const minimal = getReport(missingId)!;
    expect(minimal.status).toBe("inconclusive");
    expect(minimal.hypotheses).toEqual([]);
    expect(isReportComplete(minimal)).toBe(true);
  });

  it("finish gate nudges a reportless investigate run, then finalizes inconclusive", async () => {
    // Every turn is a free-form finish; the gate should push back MAX_NUDGES
    // times before giving up honestly.
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([{ toolUses: [], text: "All done." }]),
    );
    const sessionId = randomUUID();
    const outcome = await runInvestigation({ sessionId, alert: alert("gate") });
    expect(outcome).toBe("completed");

    const provider = mockCreateProvider.mock.results[0]!.value as {
      appendUserMessage: ReturnType<typeof vi.fn>;
      chat: ReturnType<typeof vi.fn>;
    };
    const nudges = provider.appendUserMessage.mock.calls.filter(
      ([msg]) => msg === GATE_NUDGE,
    );
    expect(nudges).toHaveLength(3);
    expect(provider.chat).toHaveBeenCalledTimes(4);
    expect(getReport(sessionId)!.status).toBe("inconclusive");
  });

  it("finish gate passes silently once the run records a complete report", async () => {
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        {
          toolUses: [
            {
              id: "tu-report-live",
              name: "UpdateReport",
              input: {
                status: "inconclusive",
                headline: "nothing found",
                rootCause: { summary: "", detail: "" },
                hypotheses: [],
                evidence: [],
                proposedFix: { summary: "", steps: [], evidenceIds: [] },
              },
            },
          ],
          text: "",
        },
        { toolUses: [], text: "Could not determine a root cause." },
      ]),
    );
    const sessionId = randomUUID();
    const outcome = await runInvestigation({
      sessionId,
      alert: alert("gate-pass"),
    });
    expect(outcome).toBe("completed");

    const provider = mockCreateProvider.mock.results[0]!.value as {
      appendUserMessage: ReturnType<typeof vi.fn>;
      chat: ReturnType<typeof vi.fn>;
    };
    expect(
      provider.appendUserMessage.mock.calls.some(([msg]) => msg === GATE_NUDGE),
    ).toBe(false);
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(getReport(sessionId)!.status).toBe("inconclusive");
  });
});
