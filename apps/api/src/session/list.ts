import type {
  Hypothesis,
  InvestigationRecord,
  SessionKind,
  SessionListPage,
  InvestigationStatus,
} from "@nightwarden/shared";
import { leadingHypothesis } from "@nightwarden/shared";
import {
  countInvestigations,
  listSessionFacts,
  type SessionListFacts,
} from "./store.js";

const WAITING_ON: Record<
  NonNullable<SessionListFacts["pendingKind"]>,
  string
> = {
  approval: "Waiting on approval",
  clarification: "Waiting on an answer",
  continue: "Waiting to continue",
};

function leadingClaim(record: InvestigationRecord | null): Hypothesis | null {
  return leadingHypothesis(record?.hypotheses ?? []);
}

// What a finished run left the user, in descending order of use: what to do,
// what it concluded, or what it ruled out so nobody repeats the work.
function whatItLeft(record: InvestigationRecord | null): string | null {
  const written = record?.report?.recommendation.trim();
  if (written) return written;
  const leading = leadingClaim(record)?.statement;
  if (leading !== undefined) return leading;
  const ruledOut = record?.hypotheses
    .filter((h) => h.verdict === "disproven")
    .at(-1);
  return ruledOut === undefined ? null : `Ruled out: ${ruledOut.statement}`;
}

// Every branch is the system's record or the model's prose, so the failure
// mode is an empty line rather than a wrong one.
function deriveStatusLine(
  facts: SessionListFacts,
  status: InvestigationStatus | null,
): string | null {
  switch (status) {
    case "action_required":
      return facts.pendingKind !== null ? WAITING_ON[facts.pendingKind] : null;
    case "running":
    // What it had settled on when the person ended it, if it had settled on
    // anything. The run stopped; the claims it made before that still stand.
    case "stopped":
      return leadingClaim(facts.record)?.statement ?? null;
    case "resolved":
      return "Alert condition recovered";
    case "completed":
      return whatItLeft(facts.record);
    case "failed":
      return facts.lastContent;
    default:
      return null;
  }
}

export function listSessionPage(
  limit: number,
  offset: number,
  kind?: SessionKind,
): SessionListPage {
  const { facts, nextOffset } = listSessionFacts(limit, offset, kind);
  return {
    rows: facts.map((row) => {
      const { investigation } = row;
      // A chat has no status to show, so the column it carries for seat
      // counting is not passed on.
      const status = investigation ? row.status : null;
      return {
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        lastActivityAt: row.lastActivityAt,
        title: row.title,
        investigation,
        severityLabel: row.alerts[0]?.alert.labels["severity"] ?? null,
        status,
        statusLine: investigation ? deriveStatusLine(row, status) : null,
        awaitingHumanInput: row.awaitingHumanInput,
      };
    }),
    nextOffset,
    investigationTotal: countInvestigations(),
  };
}
