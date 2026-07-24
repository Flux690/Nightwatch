import { serviceIdentityKey } from "@nightwarden/shared";
import type { SessionListRow, SessionRunStatus } from "@nightwarden/shared";
import { listAllPendingHumanInput } from "../db/interrupts.js";
import { listSessionSources, type SessionListSource } from "../db/sessions.js";
import { dispatcher } from "../dispatcher.js";

// Precedence: a paused agent outranks everything, then live, then the report's
// terminal, then a crash row; an investigation that ended any other way without
// a complete report was stopped. Conversations carry no status at all.
function deriveStatus(
  source: SessionListSource,
  pendingSessions: Set<string>,
): SessionRunStatus {
  if (pendingSessions.has(source.sessionId)) return "action_required";
  if (dispatcher.isSessionRunning(source.sessionId)) return "investigating";
  if (source.report?.status === "root_cause_identified") return "resolved";
  if (source.report?.status === "inconclusive") return "inconclusive";
  if (source.lastRole === "error") return "failed";
  return "stopped";
}

export function listSessionRows(): SessionListRow[] {
  const pendingSessions = new Set(
    listAllPendingHumanInput().map((p) => p.sessionId),
  );
  return listSessionSources().map((source) => {
    const investigation =
      source.originatingAlert !== null || source.report !== null;
    return {
      sessionId: source.sessionId,
      createdAt: source.createdAt,
      lastActivityAt: source.lastActivityAt,
      // The report's live headline supersedes the stored session title.
      title: source.report?.headline.trim() || source.title,
      investigation,
      severity: source.originatingAlert?.severity ?? null,
      target:
        source.originatingAlert?.targetIdentifier != null
          ? serviceIdentityKey(source.originatingAlert.targetIdentifier)
          : null,
      status: investigation ? deriveStatus(source, pendingSessions) : null,
      rootCauseLine: source.report?.rootCause.summary.trim() || null,
    };
  });
}
