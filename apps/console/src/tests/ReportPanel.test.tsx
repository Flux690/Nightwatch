import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  NormalizedAlert,
  SessionAlert,
  Report,
  ReportConviction,
  ResolvedEvidence,
} from "@nightwarden/shared";

import { ReportPanel } from "@/components/report/ReportPanel";

const RESOLVED = "2026-07-21T12:30:00.000Z";

const ALERT: NormalizedAlert = {
  sourceAlertId: "alert-1",
  labels: { service: "payments-worker" },
  alertType: "ContainerRestarting",
  severity: "critical",
  firedAt: "2026-07-21T12:00:00.000Z",
  annotations: {},
  generatorURL: null,
  rawPayload: {},
};

const INJECTED_ALERT: NormalizedAlert = {
  sourceAlertId: "alert-2",
  labels: { service: "api" },
  alertType: "HighLatency",
  severity: "warning",
  firedAt: "2026-07-21T12:20:00.000Z",
  annotations: {},
  generatorURL: null,
  rawPayload: {},
};

function onSession(
  alert: NormalizedAlert,
  clearedAt: string | null = null,
): SessionAlert {
  return {
    alert,
    arrivedAt: alert.firedAt,
    clearedAt,
    injected: false,
    droppedAlerts: 0,
  };
}

const REPORT: Report = {
  hypotheses: [
    {
      id: "h1",
      statement: "PR #482's cache bump leaks",
      verdict: "root_cause",
      finding: "climb starts at the merge timestamp",
      evidenceIds: ["tu-stats"],
      recordedAt: RESOLVED,
    },
    {
      id: "h2",
      statement: "Host memory pressure",
      verdict: "disproven",
      finding: "host free memory stayed flat",
      evidenceIds: ["tu-changes"],
      recordedAt: RESOLVED,
    },
  ],
  submitted: {
    summary: "payments-worker was OOM-killed after PR #482 raised its floor",
    timeline: [
      { at: "2026-07-21T12:05:00.000Z", what: "PR #482 merged" },
      { at: "2026-07-21T12:30:00.000Z", what: "the container was killed" },
    ],
    impact: "Nine minutes of failed payment writes",
    recommendation: "Revert PR #482",
    submittedAt: RESOLVED,
  },
  updatedAt: RESOLVED,
};

const CONVICTION: ReportConviction = { h1: "corroborated", h2: "cited" };

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
      decisions={[]}
      evidence={EVIDENCE}
      conviction={CONVICTION}
      alerts={[]}
      {...overrides}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReportPanel", () => {
  it("leads with the summary the run was written up with", () => {
    render(panel());

    // The lede is the answer, in the model's own prose, not a row lifted out of
    // the ledger and dressed up as one.
    expect(
      screen.getByRole("heading", {
        name: "payments-worker was OOM-killed after PR #482 raised its floor",
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Nine minutes of failed payment writes"),
    ).toBeInTheDocument();
    expect(screen.getByText("Revert PR #482")).toBeInTheDocument();
  });

  it("falls back to the leading claim until the run has been written up", () => {
    render(panel({ report: { ...REPORT, submitted: null } }));

    expect(
      screen.getByRole("heading", { name: "Investigation", level: 1 }),
    ).toBeInTheDocument();
    // The ledger still renders: a run that ended before its write-up is not a
    // run with nothing to show.
    expect(screen.getAllByText("PR #482's cache bump leaks")).toHaveLength(2);
    expect(screen.getByText("Root cause")).toBeInTheDocument();
  });

  it("separates what held up from what was ruled out", () => {
    render(panel());

    expect(screen.getByText("Findings")).toBeInTheDocument();
    expect(screen.getByText("Ruled out")).toBeInTheDocument();
    // The heading says it, so the row beneath does not repeat "Disproven".
    expect(screen.getByText("Root cause")).toBeInTheDocument();
    expect(screen.queryByText("Disproven")).not.toBeInTheDocument();
  });

  it("renders each of the four standing verdicts distinctly", () => {
    const verdicts = [
      "root_cause",
      "trigger",
      "symptom",
      "contributing_factor",
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
            recordedAt: RESOLVED,
          })),
        },
      }),
    );

    for (const label of [
      "Root cause",
      "Trigger",
      "Symptom",
      "Contributing factor",
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

  it("puts the released writes on the composed timeline, in one order", () => {
    render(
      panel({
        decisions: [
          {
            toolUseId: "tu-1",
            toolName: "RestartDockerService",
            target: "docker/encodr/cache",
            at: "2026-07-21T12:20:00.000Z",
            decision: "approved",
            result: '{"restarted":true}',
          },
        ],
      }),
    );

    // The model wrote two entries and the system contributed the write between
    // them: an action cannot be missing from a timeline the model did not
    // author in full.
    expect(screen.getByText("Timeline")).toBeInTheDocument();
    expect(screen.getByText("PR #482 merged")).toBeInTheDocument();
    expect(screen.getByText("RestartDockerService")).toBeInTheDocument();
    expect(screen.getByText("Ran")).toBeInTheDocument();
    expect(screen.getByText("the container was killed")).toBeInTheDocument();
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

  it("draws a call cited by several claims once and names it under the rest", () => {
    render(
      panel({
        report: {
          ...REPORT,
          hypotheses: [
            { ...REPORT.hypotheses[0]!, evidenceIds: ["tu-stats"] },
            { ...REPORT.hypotheses[1]!, evidenceIds: ["tu-stats"] },
          ],
        },
      }),
    );

    // Every claim says what it rests on, so none of them reads as unbacked.
    expect(screen.getAllByText("GetDockerStats")).toHaveLength(2);
    // One call is one measurement: read three times down the page it reads as
    // three, and a report that looks like more evidence than it has is worse
    // than one that looks like less.
    expect(screen.getAllByText(/mem 511 MB of 512 MB/)).toHaveLength(1);
  });

  it("reads a log rather than reprinting it, and links to the transcript", () => {
    render(
      panel({
        report: {
          ...REPORT,
          hypotheses: [{ ...REPORT.hypotheses[0]!, evidenceIds: ["tu-log"] }],
        },
        evidence: [
          {
            toolUseId: "tu-log",
            toolName: "GetDockerLogs",
            input: { target: "docker/encodr/payments-worker" },
            result: JSON.stringify({
              lines: [
                "fatal: cannot allocate 2.2GB buffer",
                "job 4471 accepted",
              ],
              scannedLines: 2,
            }),
          },
        ],
      }),
    );

    /* The worst line, once, as the reading. The body is not quoted at all: a
       report that reprints two hundred log lines is a transcript with extra
       steps, and the transcript is one click away. That is also what settles
       the duplicated line for good - there is no second copy to collide with. */
    expect(screen.getAllByText(/cannot allocate 2\.2GB buffer/)).toHaveLength(
      1,
    );
    expect(screen.queryByText(/job 4471 accepted/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /show in transcript/i }),
    ).toBeInTheDocument();
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
              verdict: "symptom",
              finding: "",
              evidenceIds: ["tu-never-ran"],
              recordedAt: RESOLVED,
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

  it("shows the number when a cited query returns one reading rather than a range", () => {
    // An instant query has no time axis to draw. The reading is the evidence,
    // so it is stated - never dropped for want of a chart.
    render(
      panel({
        report: {
          ...REPORT,
          submitted: null,
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

    // Read in the unit the metric names itself in. Compact notation says "8.6B"
    // for this, which is not eight gigabytes and is not caught at a glance.
    expect(screen.getByText("8.0 GB")).toBeInTheDocument();
    expect(screen.getByText("redis_memory_used_bytes")).toBeInTheDocument();
  });

  it("compares labels as bars when several series each hold one reading", () => {
    render(
      panel({
        report: {
          ...REPORT,
          submitted: null,
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
          submitted: null,
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
          submitted: null,
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

  it("shows the alert before the agent has recorded anything", () => {
    render(panel({ evidence: [], report: null, alerts: [onSession(ALERT)] }));
    expect(screen.getByText("Critical")).toBeInTheDocument();
    expect(screen.getByText("ContainerRestarting")).toBeInTheDocument();
    expect(screen.getByText(/service=payments-worker/)).toBeInTheDocument();
  });

  it("shows an alert that arrived mid-run beside the one that opened it", () => {
    render(panel({ alerts: [onSession(ALERT), onSession(INJECTED_ALERT)] }));
    expect(screen.getByText("Alerts")).toBeInTheDocument();
    expect(screen.getByText("ContainerRestarting")).toBeInTheDocument();
    expect(screen.getByText("HighLatency")).toBeInTheDocument();
  });

  it("says which alerts have recovered and which are still firing", () => {
    render(
      panel({
        alerts: [
          onSession(ALERT, "2026-07-21T13:00:00.000Z"),
          onSession(INJECTED_ALERT),
        ],
      }),
    );
    // One word, on the one that recovered: the session is not resolved while
    // the other still fires, and the band has to show why.
    expect(screen.getAllByText("Recovered")).toHaveLength(1);
  });

  it("renders no alert band on a session no alert opened", () => {
    render(panel());
    expect(screen.queryByText("Alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Alerts")).not.toBeInTheDocument();
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
              recordedAt: RESOLVED,
            },
          ],
          submitted: null,
        },
      }),
    );

    expect(screen.getByText("Ruled out")).toBeInTheDocument();
    expect(screen.queryByText("Findings")).not.toBeInTheDocument();
    expect(screen.queryByText("Root cause")).not.toBeInTheDocument();
    expect(screen.queryByText("Recommendation")).not.toBeInTheDocument();
  });

  it("tells a released write from a declined one and from a broken one", () => {
    render(
      panel({
        decisions: [
          {
            toolUseId: "tu-1",
            toolName: "RestartDockerService",
            target: "docker/encodr-prod/encodr/cache",
            at: "2026-07-21T12:10:00.000Z",
            decision: "approved",
            result: '{"restarted":true}',
          },
          {
            toolUseId: "tu-2",
            toolName: "DockerBash",
            target: null,
            at: "2026-07-21T12:12:00.000Z",
            decision: "rejected",
            outcome: "rejected",
            result: null,
          },
          {
            toolUseId: "tu-3",
            toolName: "OpenPullRequest",
            target: null,
            at: "2026-07-21T12:14:00.000Z",
            decision: "approved",
            outcome: "system",
            result:
              "There is nothing to propose: this branch has no commits against the base branch.",
          },
        ],
      }),
    );

    // Ran, declined and broken read differently. Who decided is not shown:
    // there is one user, so naming them says nothing.
    expect(screen.getByText("Ran")).toBeInTheDocument();
    expect(screen.getByText("Declined")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.queryByText(/by user/)).not.toBeInTheDocument();
  });

  it("draws no timeline on a record with neither entries nor released writes", () => {
    render(panel({ report: { ...REPORT, submitted: null }, decisions: [] }));
    expect(screen.queryByText("Timeline")).not.toBeInTheDocument();
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
