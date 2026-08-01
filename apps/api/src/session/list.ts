import type {
  Report,
  SessionListPage,
  SessionRunStatus,
  Verdict,
} from "@nightwarden/shared";
import { listSessionSources, type SessionListSource } from "../db/sessions.js";
import { dispatcher } from "../dispatcher.js";

// A symptom explains nothing on its own, and a disproven claim less; neither
// counts as the run standing behind an answer.
const CAUSES: Verdict[] = ["root_cause", "trigger", "contributing_factor"];

// Something for the operator to act on: a recommendation, or a cited root cause
// that amounts to one.
function proposedSomething(report: Report): boolean {
  return (
    report.fixes.length > 0 ||
    report.hypotheses.some(
      (h) => h.verdict === "root_cause" && h.evidenceIds.length > 0,
    )
  );
}

// Derived from the action log, the alert and the hypothesis rows, never from
// anything the model declared. A crash is checked before an unconcluded run, so
// a run that broke reads as broken rather than as one that stood down.
function deriveStatus(source: SessionListSource): SessionRunStatus | null {
  const report = source.report;
  if (source.awaitingHumanInput) return "action_required";
  if (dispatcher.isSessionRunning(source.sessionId)) return "investigating";
  if (source.remediationExecuted || source.alertCleared) return "resolved";
  if (report !== null && proposedSomething(report)) return "action_required";
  if (source.lastRole === "error") return "failed";
  // A record with no cause in it, up to and including an empty one: the run
  // ended with nothing it could stand behind.
  if (
    report === null ||
    !report.hypotheses.some((h) => CAUSES.includes(h.verdict))
  ) {
    return "inconclusive";
  }
  return null;
}

export function listSessionPage(
  limit: number,
  offset: number,
): SessionListPage {
  const { sources, nextOffset } = listSessionSources(limit, offset);
  return {
    rows: sources.map((source) => {
      const { investigation } = source;
      return {
        sessionId: source.sessionId,
        createdAt: source.createdAt,
        lastActivityAt: source.lastActivityAt,
        title: source.title,
        investigation,
        severity: source.originatingAlert?.severity ?? null,
        status: investigation ? deriveStatus(source) : null,
        awaitingHumanInput: source.awaitingHumanInput,
      };
    }),
    nextOffset,
  };
}
