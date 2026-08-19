import { describe, it, expect } from "vitest";
import type {
  NormalizedAlert,
  SessionAlert,
  SessionReportResponse,
} from "@nightwarden/shared";

import { reportToMarkdown } from "@/lib/reportMarkdown";

const AT = "2026-07-21T12:30:00.000Z";

const ALERT: NormalizedAlert = {
  sourceAlertId: "alert-1",
  labels: { severity: "critical", service: "payments-worker" },
  alertType: "ContainerRestarting",
  severity: "critical",
  firedAt: "2026-07-21T12:00:00.000Z",
  annotations: {},
  generatorURL: null,
  values: {},
  rawPayload: {},
};

const ON_SESSION: SessionAlert = {
  alert: ALERT,
  arrivedAt: ALERT.firedAt,
  clearedAt: null,
  injected: false,
  droppedAlerts: 0,
  groupContext: null,
};

const RESPONSE: SessionReportResponse = {
  report: {
    hypotheses: [
      {
        id: "h1",
        statement: "The worker buffers each source file into memory",
        verdict: "root_cause",
        finding: "the working set climbs with accepted job size",
        evidenceIds: ["tu-stats", "tu-stats", "tu-gone"],
        recordedAt: AT,
      },
      {
        id: "h2",
        statement: "The ffmpeg bump leaks",
        verdict: "disproven",
        finding: "the working set was flat across that window",
        evidenceIds: ["tu-stats"],
        recordedAt: AT,
      },
    ],
    submitted: {
      summary: "encodr-worker exhausted its limit buffering two large jobs",
      timeline: [{ at: "2026-08-03T20:11:00.000Z", what: "PR #812 merged" }],
      impact: "One transcode job dropped",
      recommendation: "Cap concurrency at one job per worker",
      submittedAt: AT,
    },
    updatedAt: AT,
  },
  decisions: [],
  evidence: [
    {
      toolUseId: "tu-stats",
      toolName: "GetDockerStats",
      kind: "metric",
      input: { target: "docker/encodr/payments-worker" },
      result: JSON.stringify({
        cpuPercent: 3.1,
        memoryUsedBytes: 511 * 1024 * 1024,
        memoryLimitBytes: 512 * 1024 * 1024,
      }),
    },
  ],
  conviction: { h1: "corroborated" },
};

/* The export is read where the console is not - in a postmortem doc, in a
   ticket - so anything it drops is gone for that reader. */
describe("reportToMarkdown", () => {
  it("carries what backs each claim, not only the claim", () => {
    const md = reportToMarkdown("encodr-worker memory", [ON_SESSION], RESPONSE);

    expect(md).toContain("### The worker buffers each source file into memory");
    expect(md).toContain("Root cause, corroborated.");
    // The call and the reading computed from its recorded result. A finding
    // exported without its backing is only the model's word for it.
    expect(md).toContain(
      "- `GetDockerStats` payments-worker - cpu 3.1% · mem 511 MB of 512 MB",
    );
    // Cited twice by one claim, carried once: a repeat is the model's slip and
    // must not read as two measurements.
    expect(md.match(/GetDockerStats/g)).toHaveLength(2);
    // A citation naming no call carries nothing rather than an empty bullet.
    expect(md).not.toContain("tu-gone");
  });

  /* The export is read where the console is not, so the line that decides
     whether anyone keeps reading has to survive the trip. */
  it("carries the headline and who was affected into the export", () => {
    const md = reportToMarkdown("encodr-worker memory", [], {
      ...RESPONSE,
      report: {
        ...RESPONSE.report,
        submitted: {
          ...RESPONSE.report.submitted!,
          headline: "PR #812 doubled the ffmpeg buffer and the worker died",
          affected: "the transcode queue",
        },
      },
    });

    expect(md).toContain(
      "**PR #812 doubled the ffmpeg buffer and the worker died**",
    );
    expect(md).toContain("Affected: the transcode queue");
    // The deck still travels: the headline replaced nothing, it leads.
    expect(md).toContain(
      "encodr-worker exhausted its limit buffering two large jobs",
    );
  });

  it("leads with the write-up, then the record it was composed from", () => {
    const md = reportToMarkdown("encodr-worker memory", [], RESPONSE);

    expect(md).toContain(
      "encodr-worker exhausted its limit buffering two large jobs",
    );
    expect(md).toContain("## What happened");
    expect(md).toContain("- 2026-08-03T20:11:00.000Z - PR #812 merged");
    expect(md).toContain("## Impact");
    expect(md).toContain("## Recommendation");
    expect(md).toContain("Cap concurrency at one job per worker");
    // What was ruled out travels too: it is the half a reader needs when the
    // agent turns out to be wrong.
    expect(md.indexOf("## What held up")).toBeLessThan(
      md.indexOf("## Ruled out"),
    );
    expect(md).toContain("### The ffmpeg bump leaks");
  });

  it("still reads as markdown when the record holds nothing but its alerts", () => {
    const md = reportToMarkdown("encodr-worker memory", [ON_SESSION], null);

    expect(md).toContain("# encodr-worker memory");
    expect(md).toContain("- ContainerRestarting (critical)");
    expect(md).toContain("still firing");
    expect(md).not.toContain("## What held up");
  });
});
