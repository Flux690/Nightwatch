import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Report } from "@nightwarden/shared";

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
      evidenceIds: ["ev-metrics", "ev-changes"],
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
  evidence: [
    {
      id: "ev-metrics",
      toolUseId: "tu-1",
      toolName: "QueryMetricsRange",
      summary: "container_memory_rss climbing 40MB/h",
      chartSnapshot: {
        seriesLabel: "container_memory_rss (payments-worker)",
        points: [
          ["2026-07-21T10:00:00.000Z", 100],
          ["2026-07-21T11:00:00.000Z", 140],
          ["2026-07-21T12:00:00.000Z", 180],
        ],
      },
    },
    {
      id: "ev-changes",
      toolUseId: "tu-2",
      toolName: "GetRecentChanges",
      summary: "PR #482 merged at the start of the climb",
      changesSnapshot: {
        pullRequests: [
          {
            number: 482,
            title: "bump cache size",
            author: "dev",
            mergedAt: "2026-07-21T10:05:00.000Z",
            url: "https://github.com/o/r/pull/482",
          },
        ],
      },
    },
  ],
  recommendedFix: {
    summary: "Revert PR #482",
    evidenceIds: ["ev-changes"],
  },
  updatedAt: "2026-07-21T12:30:00.000Z",
  model: "test",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ReportPanel", () => {
  it("renders the artifact: headline, verdict, evidence chart and changes", () => {
    render(<ReportPanel report={REPORT} actions={[]} />);

    expect(
      screen.getByText("payments-worker OOM after PR #482"),
    ).toBeInTheDocument();
    // Status is a word under the title now, not a pill beside it.
    expect(screen.getByText("Root cause identified")).toBeInTheDocument();
    expect(screen.getByText("Cache bump leaks memory")).toBeInTheDocument();
    expect(
      screen.getByText(/1 of 2 resolved|2 of 2 resolved/),
    ).toBeInTheDocument();

    // The chart is a frozen inline SVG, labeled by its series.
    expect(
      screen.getByRole("img", {
        name: "container_memory_rss (payments-worker)",
      }),
    ).toBeInTheDocument();

    // The change list links straight to the PR.
    const prLink = screen.getByRole("link", { name: /#482 bump cache size/ });
    expect(prLink).toHaveAttribute("href", "https://github.com/o/r/pull/482");
  });

  it("citation chips scroll to the cited evidence card", () => {
    // vitest.setup.ts stubs scrollIntoView on HTMLElement.prototype; spy there.
    const scrollIntoView = vi.spyOn(
      window.HTMLElement.prototype,
      "scrollIntoView",
    );
    render(<ReportPanel report={REPORT} actions={[]} />);

    // The chip's target is the evidence card anchor.
    expect(document.getElementById("evidence-ev-metrics")).not.toBeNull();

    // h1 cites both evidence entries; the fix cites the changes entry.
    const chips = screen.getAllByRole("button", { name: /show evidence/i });
    expect(chips).toHaveLength(3);

    fireEvent.click(chips[0]!);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("states an honest empty inconclusive outcome", () => {
    render(
      <ReportPanel
        actions={[]}
        report={{
          ...REPORT,
          status: "inconclusive",
          headline: "",
          rootCause: { summary: "", detail: "" },
          hypotheses: [],
          evidence: [],
          recommendedFix: { summary: "", evidenceIds: [] },
        }}
      />,
    );
    expect(screen.getByText("Investigation")).toBeInTheDocument();
    expect(screen.getByText("Inconclusive")).toBeInTheDocument();
    expect(
      screen.getByText(/ended without identifying a root cause/),
    ).toBeInTheDocument();
  });
  it("reports actions from the executor's log, not from the report text", () => {
    render(
      <ReportPanel
        report={REPORT}
        actions={[
          {
            sessionId: "s1",
            toolUseId: "tu-1",
            serviceIdentityKey: "docker/encodr-prod/encodr/cache",
            toolName: "RestartDockerService",
            status: "executed",
            resolvedBy: "operator",
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
            createdAt: "2026-07-26T17:44:00.000Z",
            resolvedAt: "2026-07-26T17:44:01.000Z",
          },
        ]}
      />,
    );

    // Executed and declined read differently, and both name who decided.
    expect(screen.getByText("Actions taken")).toBeInTheDocument();
    expect(screen.getByText("Ran")).toBeInTheDocument();
    expect(screen.getByText("Declined")).toBeInTheDocument();
    expect(screen.getAllByText(/by operator/)).toHaveLength(2);
  });

  it("omits the actions section entirely when nothing ran", () => {
    render(<ReportPanel report={REPORT} actions={[]} />);
    expect(screen.queryByText("Actions taken")).not.toBeInTheDocument();
  });

  it("links each evidence entry to the tool call that produced it", async () => {
    const scrollIntoView = vi.spyOn(
      window.HTMLElement.prototype,
      "scrollIntoView",
    );
    // The transcript lives beside the report; the anchor is the tool row's id.
    const anchor = document.createElement("div");
    anchor.id = "tool-tu-1";
    document.body.appendChild(anchor);

    render(<ReportPanel report={REPORT} actions={[]} />);

    const links = screen.getAllByRole("button", {
      name: /show in transcript/i,
    });
    expect(links.length).toBeGreaterThan(0);
    fireEvent.click(links[0]!);
    expect(scrollIntoView).toHaveBeenCalled();

    anchor.remove();
  });
});
