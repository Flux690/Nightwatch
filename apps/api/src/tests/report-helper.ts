import type { Report } from "@nightwatch/shared";
import { upsertReport } from "../db/reports.js";

// Satisfies the investigate finish gate for tests that exercise run mechanics
// rather than the report contract: inconclusive is a legal terminal state, so a
// seeded report lets a scripted run end on its free-form finish as before.
export function seedCompleteReport(sessionId: string): void {
  const report: Report = {
    status: "inconclusive",
    headline: "seeded by test",
    rootCause: { summary: "", detail: "" },
    hypotheses: [],
    evidence: [],
    proposedFix: { summary: "", steps: [], evidenceIds: [] },
    updatedAt: new Date().toISOString(),
    model: "test",
  };
  upsertReport(sessionId, report, "test");
}
