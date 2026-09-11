import { updateRecord } from "../session/record-store.js";
import { composeReport } from "../agent/report.js";

// Satisfies the finish gate for tests exercising run mechanics: one finding is a
// complete record, so the run reaches its report turn.
export async function seedCompleteReport(sessionId: string): Promise<void> {
  await updateRecord(sessionId, (record) => ({
    next: {
      ...record,
      findings: [
        {
          id: "f1",
          statement: "seeded by test",
          verdict: "disproven",
          explanation: "",
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
  await composeReport(sessionId, {
    headline: "seeded by test",
    affected: "seeded by test",
    summary: "seeded by test",
    timeline: [],
    impact: "",
    recommendation,
  });
}
