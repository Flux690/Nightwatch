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

// Every alert, not any: a batch fired together elects no primary, so one symptom
// recovering while the others still fire is not the incident being over. An
// alert that arrived mid-run counts too - it may be a second incident entirely.
function conditionRecovered(source: SessionListSource): boolean {
  return (
    source.alerts.length > 0 &&
    source.alerts.every((entry) => entry.clearedAt !== null)
  );
}

// Derived from the action log, the alerts and the hypothesis rows, never from
// anything the model declared. A crash is checked before an unconcluded run, so
// a run that broke reads as broken rather than as one that stood down.
function deriveStatus(source: SessionListSource): SessionRunStatus | null {
  const report = source.report;
  if (source.awaitingHumanInput) return "action_required";
  if (dispatcher.isSessionRunning(source.sessionId)) return "investigating";
  if (source.remediationExecuted || conditionRecovered(source)) {
    return "resolved";
  }
  if (report !== null && proposedSomething(report)) return "action_required";
  if (source.lastKind === "error") return "failed";
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
        severity: source.alerts[0]?.alert.severity ?? null,
        status: investigation ? deriveStatus(source) : null,
        awaitingHumanInput: source.awaitingHumanInput,
      };
    }),
    nextOffset,
  };
}
