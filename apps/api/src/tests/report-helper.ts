import { appendToReport } from "../db/reports.js";

// Satisfies the investigate finish gate for tests that exercise run mechanics
// rather than the record contract: one settled hypothesis is a complete record.
export function seedCompleteReport(sessionId: string): void {
  const now = new Date().toISOString();
  appendToReport(sessionId, "test", (report) => ({
    next: {
      ...report,
      hypotheses: [
        {
          id: "h1",
          statement: "seeded by test",
          verdict: "disproven",
          finding: "",
          evidenceIds: [],
          proposedAt: now,
          resolvedAt: now,
        },
      ],
    },
    value: null,
  }));
}
