import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Report, ResolvedEvidence } from "@nightwarden/shared";
import userEvent from "@testing-library/user-event";

import { ReportPanel } from "@/components/report/ReportPanel";

const REPORT: Report = {
  status: "root_cause_identified",
  headline: "payments-worker OOM after PR #482",
  rootCause: {
    summary: "Cache bump leaks memory",
    detail: "RSS climbed steadily from the merge until the OOM kill.",
  },
  hypotheses: [
    {
      id: "h1",
      statement: "PR #482's cache bump leaks",
      state: "root_cause",
      confidence: "high",
      reason: "climb starts at the merge timestamp",
      evidenceIds: ["tu-stats"],
    },
    {
      id: "h2",
      statement: "Host memory pressure",
      state: "disproven",
      confidence: "medium",
      reason: "host free memory stayed flat",
      evidenceIds: [],
    },
  ],
  recommendedFix: {
    summary: "Revert PR #482",
    evidenceIds: ["tu-changes"],
  },
  updatedAt: "2026-07-21T12:30:00.000Z",
  model: "test",
};

const EVIDENCE: ResolvedEvidence[] = [
  {
    toolUseId: "tu-stats",
    toolName: "GetDockerStats",
    input: { target: "docker/encodr/payments-worker" },
    result: JSON.stringify({
      cpuPercent: 3.1,
      memoryUsedBytes: 511 * 1024 * 1024,
      memoryLimitBytes: 512 * 1024 * 1024,
    }),
  },
  {
    toolUseId: "tu-changes",
    toolName: "GetRecentChanges",
    input: {},
    result: JSON.stringify({
      pullRequests: [
        {
          number: 482,
          title: "bump cache size",
          author: "dev",
          mergedAt: "2026-07-21T10:05:00.000Z",
          url: "https://github.com/o/r/pull/482",
        },
      ],
    }),
  },
];

function panel(overrides: Partial<Parameters<typeof ReportPanel>[0]> = {}) {
  return (
    <ReportPanel
      report={REPORT}
      actions={[]}
      evidence={EVIDENCE}
      alert={null}
      {...overrides}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReportPanel", () => {
  it("renders the artifact: headline, verdict and the root cause", () => {
    render(panel());

    expect(
      screen.getByText("payments-worker OOM after PR #482"),
    ).toBeInTheDocument();
    expect(screen.getByText("Root cause identified")).toBeInTheDocument();
    expect(screen.getByText("Cache bump leaks memory")).toBeInTheDocument();
    expect(screen.getByText("PR #482's cache bump leaks")).toBeInTheDocument();
  });

  it("puts the tool output that backs a claim underneath the claim", () => {
    render(panel());

    // The reading the claim rests on, computed from the tool's own result, so
    // checking the claim costs a glance rather than two clicks into the transcript.
    expect(screen.getByText(/mem 511 MB of 512 MB/)).toBeInTheDocument();
    expect(screen.getByText("GetDockerStats")).toBeInTheDocument();
    expect(screen.getByText("payments-worker")).toBeInTheDocument();

    // The fix cites the change list, which renders as the merged pull request.
    const prLink = screen.getByRole("link", { name: /#482 bump cache size/ });
    expect(prLink).toHaveAttribute("href", "https://github.com/o/r/pull/482");
  });

  it("keeps a claim whose citation resolves to nothing", () => {
    render(
      panel({
        report: {
          ...REPORT,
          hypotheses: [
            {
              id: "h3",
              statement: "The queue backed up first",
              state: "open",
              confidence: "low",
              reason: "",
              evidenceIds: ["tu-never-ran"],
            },
          ],
        },
      }),
    );

    // The claim survives without backing: an overreach must read as a claim
    // with nothing under it, never as a sentence that quietly disappeared.
    expect(screen.getByText("The queue backed up first")).toBeInTheDocument();
    expect(screen.queryByText("GetDockerStats")).not.toBeInTheDocument();
  });

  it("clips a long result to its first lines and reveals the rest on demand", async () => {
    const output = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join(
      "\n",
    );
    render(
      panel({
        evidence: [
          {
            toolUseId: "tu-stats",
            toolName: "GetDockerLogs",
            input: { target: "docker/encodr/payments-worker" },
            result: JSON.stringify({ lines: output.split("\n") }),
          },
        ],
      }),
    );

    // Clipped to the body cap, and the count says how much is being held back.
    expect(screen.getByText(/line-8/)).toBeInTheDocument();
    expect(screen.queryByText(/line-9/)).not.toBeInTheDocument();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /show all 12 lines/i }));
    expect(screen.getByText(/line-9/)).toBeInTheDocument();
  });

  it("shows the number when a cited query returns one reading rather than a range", () => {
    // An instant query has no time axis to draw. The reading is the evidence,
    // so it is stated - never dropped for want of a chart.
    render(
      panel({
        report: {
          ...REPORT,
          hypotheses: [{ ...REPORT.hypotheses[0]!, evidenceIds: ["tu-now"] }],
        },
        evidence: [
          {
            toolUseId: "tu-now",
            toolName: "QueryMetrics",
            input: { query: "redis_memory_used_bytes" },
            result: JSON.stringify({
              resultType: "vector",
              series: [
                {
                  metric: { __name__: "redis_memory_used_bytes" },
                  values: [[1721556000, "8589934592"]],
                },
              ],
            }),
          },
        ],
      }),
    );

    expect(screen.getByText("8.6B")).toBeInTheDocument();
    expect(screen.getByText("redis_memory_used_bytes")).toBeInTheDocument();
  });

  it("compares labels as bars when several series each hold one reading", () => {
    render(
      panel({
        report: {
          ...REPORT,
          hypotheses: [{ ...REPORT.hypotheses[0]!, evidenceIds: ["tu-top"] }],
        },
        evidence: [
          {
            toolUseId: "tu-top",
            toolName: "QueryMetrics",
            input: { query: "topk(2, container_memory_rss)" },
            result: JSON.stringify({
              resultType: "vector",
              series: [
                {
                  metric: { __name__: "rss", container: "payments-worker" },
                  values: [[1721556000, "500"]],
                },
                {
                  metric: { __name__: "rss", container: "web" },
                  values: [[1721556000, "120"]],
                },
              ],
            }),
          },
        ],
      }),
    );

    expect(screen.getByText("rss (payments-worker)")).toBeInTheDocument();
    expect(screen.getByText("rss (web)")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
  });

  it("says a cited call missed rather than passing its failure off as a reading", () => {
    render(
      panel({
        report: {
          ...REPORT,
          hypotheses: [{ ...REPORT.hypotheses[0]!, evidenceIds: ["tu-miss"] }],
        },
        evidence: [
          {
            toolUseId: "tu-miss",
            toolName: "ReadHostFile",
            input: { path: "/etc/redis/redis.conf" },
            result: "File not found: /etc/redis/redis.conf",
            outcome: "expected_miss",
          },
        ],
      }),
    );

    // The miss is the evidence here, so it reads as a plain statement; a crash
    // would carry the failure word and the failure colour instead.
    expect(screen.getByText(/File not found/)).toBeInTheDocument();
    expect(screen.queryByText(/Failed/)).not.toBeInTheDocument();
  });

  it("draws a chart from the cited metrics result, not from a stored copy", () => {
    render(
      panel({
        report: {
          ...REPORT,
          hypotheses: [{ ...REPORT.hypotheses[0]!, evidenceIds: ["tu-range"] }],
        },
        evidence: [
          {
            toolUseId: "tu-range",
            toolName: "QueryMetricsRange",
            input: { query: "container_memory_rss" },
            result: JSON.stringify({
              resultType: "matrix",
              series: [
                {
                  metric: {
                    __name__: "container_memory_rss",
                    container: "payments-worker",
                  },
                  values: [
                    [1721556000, "100"],
                    [1721559600, "140"],
                    [1721563200, "180"],
                  ],
                },
              ],
            }),
          },
        ],
      }),
    );

    expect(
      screen.getByRole("img", {
        name: "container_memory_rss (payments-worker)",
      }),
    ).toBeInTheDocument();
  });

  it("states an honest empty inconclusive outcome", () => {
    render(
      panel({
        evidence: [],
        report: {
          ...REPORT,
          status: "inconclusive",
          headline: "",
          rootCause: { summary: "", detail: "" },
          hypotheses: [],
          recommendedFix: { summary: "", evidenceIds: [] },
        },
      }),
    );
    expect(screen.getByText("Investigation")).toBeInTheDocument();
    expect(screen.getByText("Inconclusive")).toBeInTheDocument();
    expect(
      screen.getByText(/ended without identifying a root cause/),
    ).toBeInTheDocument();
  });

  it("reports actions from the executor's log, not from the report text", () => {
    render(
      panel({
        actions: [
          {
            sessionId: "s1",
            toolUseId: "tu-1",
            serviceIdentityKey: "docker/encodr-prod/encodr/cache",
            toolName: "RestartDockerService",
            status: "executed",
            resolvedBy: "operator",
            result: '{"restarted":true}',
            createdAt: "2026-07-26T17:43:00.000Z",
            resolvedAt: "2026-07-26T17:43:02.000Z",
          },
          {
            sessionId: "s1",
            toolUseId: "tu-2",
            serviceIdentityKey: null,
            toolName: "DockerBash",
            status: "rejected",
            resolvedBy: "operator",
            result: null,
            createdAt: "2026-07-26T17:44:00.000Z",
            resolvedAt: "2026-07-26T17:44:01.000Z",
          },
          {
            sessionId: "s1",
            toolUseId: "tu-3",
            serviceIdentityKey: null,
            toolName: "OpenPullRequest",
            status: "failed",
            resolvedBy: "agent",
            result:
              "There is nothing to propose: this branch has no commits against the base branch.",
            createdAt: "2026-07-26T17:45:00.000Z",
            resolvedAt: "2026-07-26T17:45:01.000Z",
          },
        ],
      }),
    );

    // Executed and declined read differently, and both name who decided.
    expect(screen.getByText("Actions taken")).toBeInTheDocument();
    expect(screen.getByText("Ran")).toBeInTheDocument();
    expect(screen.getByText("Declined")).toBeInTheDocument();
    expect(screen.getAllByText(/by operator/)).toHaveLength(2);

    // A failure states its cause; a success does not repeat its own output here.
    expect(screen.getByText(/nothing to propose/)).toBeInTheDocument();
    expect(screen.queryByText(/restarted/)).not.toBeInTheDocument();
  });

  it("omits the actions section entirely when nothing ran", () => {
    render(panel());
    expect(screen.queryByText("Actions taken")).not.toBeInTheDocument();
  });

  it("tells the transcript which call to reveal, not just where to scroll", () => {
    const revealed: string[] = [];
    const listener = (e: Event): void => {
      revealed.push((e as CustomEvent<string>).detail);
    };
    window.addEventListener("nw:reveal-tool-call", listener);

    render(panel());
    fireEvent.click(
      screen.getAllByRole("button", { name: /show in transcript/i })[0]!,
    );

    expect(revealed).toEqual(["tu-stats"]);
    window.removeEventListener("nw:reveal-tool-call", listener);
  });
});
