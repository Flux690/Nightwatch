import { getDb } from "./client.js";
import type { ToolResult } from "../llm/types.js";

/* The gate a session is parked on: four columns on the session row, since there
   is at most one per session and nothing queried it by anything else. What a
   person decided is not here - that is durable and lives on the transcript. */
export interface PendingHumanInput {
  sessionId: string;
  toolUseId: string;
  kind: "approval" | "clarification" | "continue";
  completedResults: ToolResult[];
  claimedAt?: string | null;
}

interface RawRow {
  sessionId: string;
  toolUseId: string | null;
  kind: string | null;
  completedResults: string;
  claimedAt: string | null;
}

export function isHumanInputKind(
  kind: string,
): kind is PendingHumanInput["kind"] {
  return kind === "approval" || kind === "clarification" || kind === "continue";
}

// Untrusted on read despite being our own UPDATE (partial write, schema drift):
// fail loudly on a bad kind or JSON rather than crashing deep in the resume path.
function parseRow(row: RawRow): PendingHumanInput | undefined {
  if (row.toolUseId === null || row.kind === null) return undefined;
  if (!isHumanInputKind(row.kind)) {
    throw new Error(
      `sessions(${row.sessionId}) has unknown awaiting_kind "${row.kind}"`,
    );
  }
  let completedResults: ToolResult[];
  try {
    completedResults = JSON.parse(row.completedResults) as ToolResult[];
  } catch (err) {
    throw new Error(
      `sessions(${row.sessionId}) has corrupt awaiting_results: ${
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

// Written in the same transaction as the turn that suspended, by
// appendRowsAndInterrupt, so a run is never reachable without its gate.
export function parkOnHumanInput(pending: PendingHumanInput): void {
  getDb()
    .prepare(
      `UPDATE sessions
          SET awaiting_tool_use_id = ?, awaiting_kind = ?,
              awaiting_results = ?, attempt_started_at = NULL
        WHERE session_id = ?`,
    )
    .run(
      pending.toolUseId,
      pending.kind,
      JSON.stringify(pending.completedResults),
      pending.sessionId,
    );
}

/* The mutex on answering. Claiming stamps the instant an attempt began, which is
   what a boot after a crash reads to tell "nobody answered yet" from "a write may
   already have run". Conditional, so two requests cannot both resolve one gate. */
export function claimPendingHumanInput(sessionId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE sessions
          SET attempt_started_at = ?
        WHERE session_id = ?
          AND awaiting_tool_use_id IS NOT NULL
          AND attempt_started_at IS NULL`,
    )
    .run(new Date().toISOString(), sessionId);
  return result.changes > 0;
}

export function deletePendingHumanInput(sessionId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE sessions
          SET awaiting_tool_use_id = NULL, awaiting_kind = NULL,
              awaiting_results = '[]', attempt_started_at = NULL
        WHERE session_id = ? AND awaiting_tool_use_id IS NOT NULL`,
    )
    .run(sessionId);
  return result.changes > 0;
}

export function getPendingHumanInputBySessionId(
  sessionId: string,
): PendingHumanInput | undefined {
  const row = getDb()
    .prepare(
      `SELECT session_id AS sessionId, awaiting_tool_use_id AS toolUseId,
              awaiting_kind AS kind, awaiting_results AS completedResults,
              attempt_started_at AS claimedAt
         FROM sessions
        WHERE session_id = ?`,
    )
    .get(sessionId) as RawRow | undefined;
  return row ? parseRow(row) : undefined;
}

// 409 guard: true if this session has pending human input.
export function hasPendingHumanInput(sessionId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM sessions
        WHERE session_id = ? AND awaiting_tool_use_id IS NOT NULL LIMIT 1`,
    )
    .get(sessionId);
  return row != null;
}
