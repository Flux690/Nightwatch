import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  Report,
  ReportConviction,
  ResolvedEvidence,
} from "@nightwarden/shared";
import userEvent from "@testing-library/user-event";

import { ReportPanel } from "@/components/report/ReportPanel";

const RESOLVED = "2026-07-21T12:30:00.000Z";

const REPORT: Report = {
  hypotheses: [
    {
      id: "h1",
      statement: "PR #482's cache bump leaks",
      verdict: "root_cause",
      finding: "climb starts at the merge timestamp",
      evidenceIds: ["tu-stats"],
      proposedAt: RESOLVED,
      resolvedAt: RESOLVED,
    },
    {
      id: "h2",
      statement: "Host memory pressure",
      verdict: "disproven",
      finding: "host free memory stayed flat",
      evidenceIds: [],
      proposedAt: RESOLVED,
      resolvedAt: RESOLVED,
    },
  ],
  fixes: [
    {
      id: "f1",
      summary: "Revert PR #482",
      evidenceIds: ["tu-changes"],
      recordedAt: RESOLVED,
    },
  ],
  updatedAt: RESOLVED,
  model: "test",
};

const CONVICTION: ReportConviction = { h1: "corroborated", f1: "cited" };

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
      conviction={CONVICTION}
      alert={null}
      {...overrides}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReportPanel", () => {
  it("leads with the hypothesis that resolved as the root cause", () => {
    render(panel());

    // The verdict line and the row beneath it are one claim, so there is no
    // second place for the cause to disagree with itself.
    expect(screen.getAllByText("PR #482's cache bump leaks")).toHaveLength(2);
    expect(screen.getByText("Root cause")).toBeInTheDocument();
    expect(screen.getByText("Disproven")).toBeInTheDocument();
  });

  it("renders each of the six verdicts distinctly", () => {
    const verdicts = [
      "root_cause",
      "trigger",
      "symptom",
      "contributing_factor",
      "disproven",
      "open",
    ] as const;
    render(
      panel({
        report: {
          ...REPORT,
          hypotheses: verdicts.map((verdict, i) => ({
            id: `h${i + 1}`,
            statement: `claim ${verdict}`,
            verdict,
            finding: "",
            evidenceIds: [],
            proposedAt: RESOLVED,
            resolvedAt: RESOLVED,
          })),
        },
      }),
    );

    for (const label of [
      "Root cause",
      "Trigger",
      "Symptom",
      "Contributing factor",
      "Disproven",
      "Open",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("marks how well each claim is backed, and marks nothing when it is not", () => {
    render(panel());

    expect(screen.getByText("corroborated")).toBeInTheDocument();
    expect(screen.getByText("cited")).toBeInTheDocument();
    // h2 earned nothing, and absence is the whole signal: no warning badge.
    expect(screen.queryByText("verified")).not.toBeInTheDocument();
  });

  it("keeps a rejected fix on screen beside the one that replaced it", () => {
    render(
      panel({
        report: {
          ...REPORT,
          fixes: [
            {
              id: "f1",
              summary: "Revert PR #482",
              evidenceIds: [],
              recordedAt: RESOLVED,
            },
            {
              id: "f2",
              summary: "Raise the memory limit instead",
              evidenceIds: [],
              recordedAt: RESOLVED,
            },
          ],
        },
      }),
    );

    // A recommendation the operator turned down is part of the record, and
    // which one stands has to be legible without reading the transcript.
    expect(screen.getByText("Revert PR #482")).toBeInTheDocument();
    expect(
      screen.getByText("Raise the memory limit instead"),
    ).toBeInTheDocument();
    expect(screen.getByText("Superseded")).toBeInTheDocument();
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
              verdict: "open",
              finding: "",
              evidenceIds: ["tu-never-ran"],
              proposedAt: RESOLVED,
              resolvedAt: null,
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
          fixes: [],
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
          fixes: [],
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
          fixes: [],
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
          fixes: [],
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

  it("states an investigation that has recorded nothing", () => {
    render(panel({ evidence: [], report: null }));
    expect(screen.getByText("Investigation")).toBeInTheDocument();
    expect(
      screen.getByText(/has not recorded a finding yet/),
    ).toBeInTheDocument();
  });

  it("says the run could not conclude by showing what it settled and no cause", () => {
    render(
      panel({
        evidence: [],
        conviction: {},
        report: {
          ...REPORT,
          hypotheses: [
            {
              id: "h1",
              statement: "Host memory pressure",
              verdict: "disproven",
              finding: "host free memory stayed flat",
              evidenceIds: [],
              proposedAt: RESOLVED,
              resolvedAt: RESOLVED,
            },
          ],
          fixes: [],
        },
      }),
    );

    expect(screen.getByText("Disproven")).toBeInTheDocument();
    expect(screen.queryByText("Root cause")).not.toBeInTheDocument();
    expect(screen.queryByText("Proposed fix")).not.toBeInTheDocument();
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
