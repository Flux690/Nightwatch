import { getDb } from "./client.js";
import type { ToolResult } from "../llm/types.js";

// A pointer at the gated call, and the results of the turn's other calls, which
// have nowhere valid to sit until that one is answered too. What the call was is
// the transcript's to say: `findToolCall` reads it under the same id.
export interface PendingHumanInput {
  sessionId: string;
  toolUseId: string;
  kind: "approval" | "clarification" | "continue";
  completedResults: ToolResult[];
  claimedAt?: string | null;
}

interface RawRow {
  sessionId: string;
  toolUseId: string;
  kind: string;
  completedResults: string;
  claimedAt: string | null;
}

export function isHumanInputKind(
  kind: string,
): kind is PendingHumanInput["kind"] {
  return kind === "approval" || kind === "clarification" || kind === "continue";
}

// Untrusted on read despite being our own INSERT (partial write, schema drift):
// fail loudly on a bad kind or JSON rather than crashing deep in the resume path.
function parseRow(row: RawRow): PendingHumanInput {
  if (!isHumanInputKind(row.kind)) {
    throw new Error(
      `pending_human_input(${row.sessionId}) has unknown kind "${row.kind}"`,
    );
  }
  let completedResults: ToolResult[];
  try {
    completedResults = JSON.parse(row.completedResults) as ToolResult[];
  } catch (err) {
    throw new Error(
      `pending_human_input(${row.sessionId}) has corrupt JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return {
    sessionId: row.sessionId,
    toolUseId: row.toolUseId,
    kind: row.kind,
    completedResults,
    claimedAt: row.claimedAt,
  };
}

export function insertPendingHumanInput(
  pendingHumanInput: PendingHumanInput,
): void {
  getDb()
    .prepare(
      `INSERT INTO pending_human_input
         (session_id, tool_use_id, kind, completed_results, claimed_at)
       VALUES
         (@sessionId, @toolUseId, @kind, @completedResults, @claimedAt)`,
    )
    .run({
      sessionId: pendingHumanInput.sessionId,
      toolUseId: pendingHumanInput.toolUseId,
      kind: pendingHumanInput.kind,
      completedResults: JSON.stringify(pendingHumanInput.completedResults),
      claimedAt: pendingHumanInput.claimedAt ?? null,
    });
}

export function claimPendingHumanInput(sessionId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE pending_human_input
       SET claimed_at = ?
       WHERE session_id = ? AND claimed_at IS NULL`,
    )
    .run(new Date().toISOString(), sessionId);
  return result.changes > 0;
}

export function deletePendingHumanInput(sessionId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM pending_human_input WHERE session_id = ?`)
    .run(sessionId);
  return result.changes > 0;
}

export function getPendingHumanInputBySessionId(
  sessionId: string,
): PendingHumanInput | undefined {
  const row = getDb()
    .prepare(
      `SELECT session_id AS sessionId, tool_use_id AS toolUseId, kind,
              completed_results AS completedResults, claimed_at AS claimedAt
       FROM pending_human_input
       WHERE session_id = ?`,
    )
    .get(sessionId) as RawRow | undefined;
  return row ? parseRow(row) : undefined;
}

// Dedup: true if a session for this alert is durably suspended.
export function hasPendingHumanInputForAlert(
  sourceAlertId: string,
  firedAt: string,
): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM pending_human_input pi
       JOIN sessions s ON s.session_id = pi.session_id
       WHERE EXISTS (SELECT 1 FROM json_each(s.alerts)
                     WHERE json_extract(value, '$.alert.sourceAlertId') = ?
                       AND json_extract(value, '$.alert.firedAt') = ?)
       LIMIT 1`,
    )
    .get(sourceAlertId, firedAt);
  return row != null;
}

// 409 guard: true if this session has pending human input.
export function hasPendingHumanInput(sessionId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM pending_human_input WHERE session_id = ? LIMIT 1`)
    .get(sessionId);
  return row != null;
}
