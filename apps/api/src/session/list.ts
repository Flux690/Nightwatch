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
import { proposedSomething } from "../agent/report.js";
import { dispatcher } from "../dispatcher.js";

/* The alert that fired is what says the incident is over, so a write running
   while it still fires settles nothing - and whether a write even happened is a
   question nothing can answer, since an approved shell command may only have
   read. The condition is the one signal that means what it says. */
function isSettled(source: SessionListSource): boolean {
  return (
    source.alerts.length > 0 &&
    source.alerts.every((entry) => entry.clearedAt !== null)
  );
}

/* Derived from the alerts, the dispatcher and the hypothesis rows, never from
   anything the model declared. A crash is checked before an unconcluded run, so
   a run that broke reads as broken rather than as one that stood down.

   Total by construction: every investigation lands in exactly one group. The
   fall-through used to answer null, which put a record in no group on the page
   while still counting in the queue total - so the stepper read "3 / 12" over
   eleven rows. */
function deriveStatus(source: SessionListSource): SessionRunStatus {
  const report = source.report;
  if (source.awaitingHumanInput) return "action_required";
  if (dispatcher.isSessionRunning(source.sessionId)) return "investigating";
  if (isSettled(source)) return "resolved";
  if (report !== null && proposedSomething(report)) return "action_required";
  if (source.lastKind === "error") return "failed";
  // Nothing for the operator to act on: the run ended without a recommendation,
  // whether or not it named a cause along the way.
  return "inconclusive";
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

// What it waits on when nobody is gating it: the recommendation it wrote, or the
// claim that amounts to one. Mirrors proposedSomething, which put it here.
function awaitedRecommendation(report: Report | null): string | null {
  const recommendation = report?.submitted?.recommendation.trim();
  return recommendation
    ? recommendation
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
      return "Alert condition recovered";
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
    investigationTotal: investigations.length,
  };
}
