import { getDb } from "./client.js";
import type { ToolResult } from "../llm/types.js";

export interface PendingHumanInput {
  sessionId: string;
  toolUseId: string;
  kind: "approval" | "clarification" | "continue";
  toolName: string;
  toolInput: Record<string, unknown>;
  completedResults: ToolResult[];
  claimedAt?: string | null;
  createdAt: string;
}

interface RawRow {
  sessionId: string;
  toolUseId: string;
  kind: string;
  toolName: string;
  toolInput: string;
  completedResults: string;
  claimedAt: string | null;
  createdAt: string;
}

function isHumanInputKind(kind: string): kind is PendingHumanInput["kind"] {
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
  let toolInput: Record<string, unknown>;
  let completedResults: ToolResult[];
  try {
    toolInput = JSON.parse(row.toolInput) as Record<string, unknown>;
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
    toolName: row.toolName,
    toolInput,
    completedResults,
    claimedAt: row.claimedAt,
    createdAt: row.createdAt,
  };
}

export function insertPendingHumanInput(
  pendingHumanInput: PendingHumanInput,
): void {
  getDb()
    .prepare(
      `INSERT INTO pending_human_input
         (session_id, tool_use_id, kind, tool_name, tool_input, completed_results, claimed_at, created_at)
       VALUES
         (@sessionId, @toolUseId, @kind, @toolName, @toolInput, @completedResults, @claimedAt, @createdAt)`,
    )
    .run({
      sessionId: pendingHumanInput.sessionId,
      toolUseId: pendingHumanInput.toolUseId,
      kind: pendingHumanInput.kind,
      toolName: pendingHumanInput.toolName,
      toolInput: JSON.stringify(pendingHumanInput.toolInput),
      completedResults: JSON.stringify(pendingHumanInput.completedResults),
      claimedAt: pendingHumanInput.claimedAt ?? null,
      createdAt: pendingHumanInput.createdAt,
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
      `SELECT session_id AS sessionId, tool_use_id AS toolUseId,
              kind, tool_name AS toolName, tool_input AS toolInput,
              completed_results AS completedResults, claimed_at AS claimedAt,
              created_at AS createdAt
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
       WHERE json_extract(s.originating_alert, '$.sourceAlertId') = ?
         AND json_extract(s.originating_alert, '$.firedAt') = ?
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
