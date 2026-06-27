import { getDb } from "./client.js";
import type { ToolResult } from "../llm/types.js";
import type { NormalizedAlert } from "@nightwatch/shared";

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

export interface PendingHumanInputWithSession extends PendingHumanInput {
  originatingAlert: NormalizedAlert | null;
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

interface RawRowWithSession extends RawRow {
  originatingAlert: string | null;
}

function isHumanInputKind(kind: string): kind is PendingHumanInput["kind"] {
  return kind === "approval" || kind === "clarification" || kind === "continue";
}

// The row comes from our own typed INSERT, but it is still untrusted bytes on
// read: a partial write, a hand-edited DB, or a schema drift could yield an
// unknown kind or malformed JSON. Fail loudly here rather than letting a bad cast
// or a thrown JSON.parse surface deep in the resume path as an opaque crash.
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

function parseRowWithSession(
  row: RawRowWithSession,
): PendingHumanInputWithSession {
  return {
    ...parseRow(row),
    originatingAlert:
      row.originatingAlert != null
        ? (JSON.parse(row.originatingAlert) as NormalizedAlert)
        : null,
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

export function getPendingHumanInputWithSessionBySessionId(
  sessionId: string,
): PendingHumanInputWithSession | undefined {
  const row = getDb()
    .prepare(
      `SELECT pi.session_id AS sessionId, pi.tool_use_id AS toolUseId,
              pi.kind, pi.tool_name AS toolName, pi.tool_input AS toolInput,
              pi.completed_results AS completedResults, pi.claimed_at AS claimedAt,
              pi.created_at AS createdAt, s.originating_alert AS originatingAlert
       FROM pending_human_input pi
       JOIN sessions s ON s.session_id = pi.session_id
       WHERE pi.session_id = ?`,
    )
    .get(sessionId) as RawRowWithSession | undefined;
  return row ? parseRowWithSession(row) : undefined;
}

export function listAllPendingHumanInput(): PendingHumanInputWithSession[] {
  const rows = getDb()
    .prepare(
      `SELECT pi.session_id AS sessionId, pi.tool_use_id AS toolUseId,
              pi.kind, pi.tool_name AS toolName, pi.tool_input AS toolInput,
              pi.completed_results AS completedResults, pi.claimed_at AS claimedAt,
              pi.created_at AS createdAt, s.originating_alert AS originatingAlert
       FROM pending_human_input pi
       JOIN sessions s ON s.session_id = pi.session_id`,
    )
    .all() as RawRowWithSession[];
  return rows.map(parseRowWithSession);
}

// Dedup: true if a session for this alert is durably suspended.
export function hasPendingHumanInputForAlert(
  runnerId: string,
  sourceAlertId: string,
): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM pending_human_input pi
       JOIN sessions s ON s.session_id = pi.session_id
       WHERE json_extract(s.originating_alert, '$.runnerId') = ?
         AND json_extract(s.originating_alert, '$.sourceAlertId') = ?
       LIMIT 1`,
    )
    .get(runnerId, sourceAlertId);
  return row != null;
}

// 409 guard: true if this session has pending human input.
export function hasPendingHumanInput(sessionId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM pending_human_input WHERE session_id = ? LIMIT 1`)
    .get(sessionId);
  return row != null;
}
