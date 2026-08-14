import { appendToReport } from "../db/reports.js";
import { submitReport } from "../agent/report.js";

// Satisfies the ledger gate for tests that exercise run mechanics rather than
// the record contract: one recorded hypothesis is a complete ledger, so the run
// reaches its report turn instead of being nudged.
export function seedCompleteReport(sessionId: string): void {
  appendToReport(sessionId, (report) => ({
    next: {
      ...report,
      hypotheses: [
        {
          id: "h1",
          statement: "seeded by test",
          verdict: "disproven",
          finding: "",
          evidenceIds: [],
          recordedAt: new Date().toISOString(),
        },
      ],
    },
    value: null,
  }));
}

// A finished write-up carrying one recommendation, for tests about what an
// investigation is waiting on rather than about how it was written.
export function seedRecommendation(
  sessionId: string,
  recommendation: string,
): void {
  submitReport(sessionId, {
    summary: "seeded by test",
    timeline: [],
    impact: "",
    recommendation,
  });
}
