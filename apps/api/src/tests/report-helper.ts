import { appendHypothesis } from "../session/record-store.js";
import { submitReport } from "../agent/report.js";

// Satisfies the finish gate for tests that exercise run mechanics rather than
// the record contract: one recorded hypothesis is a complete record, so the run
// reaches its report turn instead of being pushed back.
export async function seedCompleteReport(sessionId: string): Promise<void> {
  await appendHypothesis(sessionId, (report) => ({
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
export async function seedRecommendation(
  sessionId: string,
  recommendation: string,
): Promise<void> {
  await submitReport(sessionId, {
    headline: "seeded by test",
    affected: "seeded by test",
    summary: "seeded by test",
    timeline: [],
    impact: "",
    recommendation,
  });
}
