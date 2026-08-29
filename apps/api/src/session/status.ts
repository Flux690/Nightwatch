import type { InvestigationStatus } from "@nightwarden/shared";
import { getDb } from "../db.js";

// Every status but `running` is answerable from the session's own columns.
// `running` means a process is executing it, so run-state.ts claims that one.

interface StatusFacts {
  gated: number;
  stoppedAt: string | null;
  alerts: number;
  openAlerts: number;
  lastKind: string | null;
}

const FACTS = `
  SELECT (s.awaiting_tool_use_id IS NOT NULL) AS gated,
         s.stopped_at AS stoppedAt,
         (SELECT COUNT(*) FROM alerts a
           WHERE a.session_id = s.session_id) AS alerts,
         (SELECT COUNT(*) FROM alerts a
           WHERE a.session_id = s.session_id AND a.cleared_at IS NULL)
           AS openAlerts,
         (SELECT m.kind FROM session_transcript m
           WHERE m.session_id = s.session_id
           ORDER BY m.seq DESC LIMIT 1) AS lastKind
    FROM sessions s WHERE s.session_id = ?`;

// The order is the meaning: a gate leads because someone is being asked
// something now, and a recovered incident outranks who ended the run.
function statusFrom(facts: StatusFacts): InvestigationStatus {
  if (facts.gated === 1) return "action_required";
  // A session that fired on no alert has no condition to recover, so the alert
  // count is checked as well as the open count.
  if (facts.alerts > 0 && facts.openAlerts === 0) return "resolved";
  if (facts.stoppedAt !== null) return "stopped";
  if (facts.lastKind === "error") return "failed";
  return "completed";
}

export function deriveStatus(sessionId: string): InvestigationStatus {
  const facts = getDb().prepare(FACTS).get(sessionId) as
    StatusFacts | undefined;
  return facts === undefined ? "completed" : statusFrom(facts);
}

// Guarded, so a transition elsewhere cannot pull a live run out of `running`.
// A plain UPDATE, so a caller inside a transaction can write both facts at once.
export function refreshSessionStatus(sessionId: string): void {
  getDb()
    .prepare(
      `UPDATE sessions SET status = ?
       WHERE session_id = ? AND status <> 'running'`,
    )
    .run(deriveStatus(sessionId), sessionId);
}
