import type {
  Hypothesis,
  Report,
  SessionKind,
  SessionListPage,
  SessionRunStatus,
} from "@nightwarden/shared";
import { leadingHypothesis } from "@nightwarden/shared";
import {
  countInvestigations,
  listSessionSources,
  type SessionListSource,
} from "../db/sessions.js";
import { isActionable } from "../agent/report.js";
import { dispatcher } from "../dispatcher.js";

// The condition is the one signal that means what it says: whether a write even
// happened is unanswerable, since an approved shell command may only have read.
function isSettled(source: SessionListSource): boolean {
  return (
    source.alerts.length > 0 &&
    source.alerts.every((entry) => entry.clearedAt !== null)
  );
}

/* Derived, never declared by the model. A crash is checked before an unconcluded
   run, so a broken run reads as broken. Total by construction: a fall-through of
   null put a record in no group while still counting in the queue total. */
function deriveStatus(source: SessionListSource): SessionRunStatus {
  const report = source.report;
  if (source.awaitingHumanInput) return "action_required";
  if (dispatcher.isSessionRunning(source.sessionId)) return "investigating";
  if (isSettled(source)) return "resolved";
  if (report !== null && isActionable(report)) return "action_required";
  if (source.lastKind === "error") return "failed";
  // Nothing for the user to act on: the run ended without a recommendation,
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

function leadingClaim(report: Report | null): Hypothesis | null {
  return leadingHypothesis(report?.hypotheses ?? []);
}

// What it waits on when nobody is gating it: the recommendation it wrote, or the
// claim that amounts to one. Mirrors isActionable, which put it here.
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
    investigationTotal: countInvestigations(),
  };
}
