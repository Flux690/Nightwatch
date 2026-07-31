import { isToolOutcome } from "@nightwarden/shared";
import type { ToolOutcome } from "@nightwarden/shared";
import { getDb } from "./client.js";

// Recorded when the call settles. The provider round-trip the transcript is
// rebuilt from carries no room for our own classification - one dialect has no
// error flag at all - so a reloaded session reads it from here.
export function recordToolOutcome(
  sessionId: string,
  toolUseId: string,
  outcome: ToolOutcome,
): void {
  getDb()
    .prepare(
      `INSERT INTO tool_outcomes (session_id, tool_use_id, outcome)
       VALUES (@sessionId, @toolUseId, @outcome)
       ON CONFLICT (session_id, tool_use_id) DO UPDATE SET outcome = @outcome`,
    )
    .run({ sessionId, toolUseId, outcome });
}

export function getToolOutcomes(sessionId: string): Map<string, ToolOutcome> {
  const rows = getDb()
    .prepare(
      `SELECT tool_use_id AS toolUseId, outcome FROM tool_outcomes WHERE session_id = ?`,
    )
    .all(sessionId) as Array<{ toolUseId: string; outcome: string }>;
  // A word this build no longer knows renders as unclassified, which is what an
  // unrecorded call already does - the one honest answer when the class is gone.
  return new Map(
    rows.flatMap((row) =>
      isToolOutcome(row.outcome) ? [[row.toolUseId, row.outcome] as const] : [],
    ),
  );
}
