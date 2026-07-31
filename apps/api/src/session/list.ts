import type { SessionListPage, SessionRunStatus } from "@nightwarden/shared";
import { listSessionSources, type SessionListSource } from "../db/sessions.js";
import { dispatcher } from "../dispatcher.js";

// Precedence: a paused agent outranks everything, then live, then the report's
// terminal, then a crash row; an investigation that ended any other way without
// a complete report was stopped. Conversations carry no status at all.
function deriveStatus(source: SessionListSource): SessionRunStatus {
  if (source.awaitingHumanInput) return "action_required";
  if (dispatcher.isSessionRunning(source.sessionId)) return "investigating";
  if (source.report?.status === "root_cause_identified") return "resolved";
  if (source.report?.status === "inconclusive") return "inconclusive";
  if (source.lastRole === "error") return "failed";
  return "stopped";
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
        // The report's live headline supersedes the stored session title.
        title: source.report?.headline.trim() || source.title,
        investigation,
        severity: source.originatingAlert?.severity ?? null,
        status: investigation ? deriveStatus(source) : null,
        rootCauseLine: source.report?.rootCause.summary.trim() || null,
        awaitingHumanInput: source.awaitingHumanInput,
      };
    }),
    nextOffset,
  };
}
