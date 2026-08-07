import type {
  Hypothesis,
  Report,
  SessionKind,
  SessionListPage,
  SessionRunStatus,
  Verdict,
} from "@nightwarden/shared";
import {
  listInvestigationSources,
  listSessionSources,
  type SessionListSource,
} from "../db/sessions.js";
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

// The alert that fired is what says the incident is over, so a remediation
// running while it still fires settles nothing. Where no alert fired there is
// nothing to recover, and an executed remediation is the only signal there is.
function isSettled(source: SessionListSource): boolean {
  return source.alerts.length > 0
    ? source.alerts.every((entry) => entry.clearedAt !== null)
    : source.remediationExecuted;
}

// Derived from the action log, the alerts and the hypothesis rows, never from
// anything the model declared. A crash is checked before an unconcluded run, so
// a run that broke reads as broken rather than as one that stood down.
function deriveStatus(source: SessionListSource): SessionRunStatus | null {
  const report = source.report;
  if (source.awaitingHumanInput) return "action_required";
  if (dispatcher.isSessionRunning(source.sessionId)) return "investigating";
  if (isSettled(source)) return "resolved";
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

const WAITING_ON: Record<
  NonNullable<SessionListSource["pendingKind"]>,
  string
> = {
  approval: "Waiting on approval",
  clarification: "Waiting on an answer",
  continue: "Waiting to continue",
};

// Most confident first. Disproven leads nothing, so it is absent from the
// ranking rather than last in it.
const CONFIDENCE: Verdict[] = [
  "root_cause",
  "trigger",
  "contributing_factor",
  "symptom",
  "open",
];

// Rows are appended in proposal order, so `<=` lets the newer of two equally
// confident claims lead - the one the run reached last.
function leadingClaim(report: Report | null): Hypothesis | null {
  let best: Hypothesis | null = null;
  let bestRank = CONFIDENCE.length;
  for (const h of report?.hypotheses ?? []) {
    const rank = CONFIDENCE.indexOf(h.verdict);
    if (rank !== -1 && rank <= bestRank) {
      best = h;
      bestRank = rank;
    }
  }
  return best;
}

// What it waits on when nobody is gating it: the fix it proposed, or the claim
// that amounts to one. Mirrors proposedSomething, which put it here.
function awaitedRecommendation(report: Report | null): string | null {
  const fix = report?.fixes.at(-1);
  return fix !== undefined
    ? fix.summary
    : (leadingClaim(report)?.statement ?? null);
}

// One line answering the question the status raises. Every branch is the
// system's own record or the model's prose; nothing is inferred, so the failure
// mode is an empty line rather than a wrong one.
function deriveFinding(
  source: SessionListSource,
  status: SessionRunStatus | null,
): string | null {
  switch (status) {
    case "action_required":
      return source.pendingKind !== null
        ? WAITING_ON[source.pendingKind]
        : awaitedRecommendation(source.report);
    case "investigating":
      return leadingClaim(source.report)?.statement ?? null;
    case "resolved":
      return source.alerts.length > 0
        ? "Alert condition recovered"
        : "A remediation ran";
    case "inconclusive": {
      const ruledOut = source.report?.hypotheses
        .filter((h) => h.verdict === "disproven")
        .at(-1);
      return ruledOut === undefined ? null : `Ruled out: ${ruledOut.statement}`;
    }
    case "failed":
      return source.lastContent;
    default:
      return null;
  }
}

export function listSessionPage(
  limit: number,
  offset: number,
  kind?: SessionKind,
): SessionListPage {
  const { sources, nextOffset } = listSessionSources(limit, offset, kind);
  const investigations = listInvestigationSources();
  return {
    rows: sources.map((source) => {
      const { investigation } = source;
      const status = investigation ? deriveStatus(source) : null;
      return {
        sessionId: source.sessionId,
        createdAt: source.createdAt,
        lastActivityAt: source.lastActivityAt,
        title: source.title,
        investigation,
        severity: source.alerts[0]?.alert.severity ?? null,
        severityLabel: source.alerts[0]?.alert.labels["severity"] ?? null,
        status,
        finding: investigation ? deriveFinding(source, status) : null,
        awaitingHumanInput: source.awaitingHumanInput,
      };
    }),
    nextOffset,
    actionRequiredCount: investigations.filter(
      (s) => deriveStatus(s) === "action_required",
    ).length,
    investigationTotal: investigations.length,
  };
}
