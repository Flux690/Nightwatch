import { getDb } from "./client.js";
import type { ToolResult } from "../llm/types.js";
import type { NormalizedAlert, SessionTrigger } from "@nightwatch/shared";

export interface PendingInterrupt {
  id: string;
  sessionId: string;
  toolUseId: string;
  kind: "approval" | "clarification";
  toolName: string;
  toolInput: Record<string, unknown>;
  completedResults: ToolResult[];
  createdAt: string;
}

export interface PendingInterruptWithSession extends PendingInterrupt {
  token: string;
  originatingAlert: NormalizedAlert | null;
  sessionTrigger: SessionTrigger;
}

interface RawRow {
  id: string;
  sessionId: string;
  toolUseId: string;
  kind: string;
  toolName: string;
  toolInput: string;
  completedResults: string;
  createdAt: string;
}

interface RawRowWithSession extends RawRow {
  token: string;
  originatingAlert: string | null;
  sessionTrigger: string;
}

function parseRow(row: RawRow): PendingInterrupt {
  return {
    id: row.id,
    sessionId: row.sessionId,
    toolUseId: row.toolUseId,
    kind: row.kind as "approval" | "clarification",
    toolName: row.toolName,
    toolInput: JSON.parse(row.toolInput) as Record<string, unknown>,
    completedResults: JSON.parse(row.completedResults) as ToolResult[],
    createdAt: row.createdAt,
  };
}

function parseRowWithSession(
  row: RawRowWithSession,
): PendingInterruptWithSession {
  return {
    ...parseRow(row),
    token: row.token,
    originatingAlert:
      row.originatingAlert != null
        ? (JSON.parse(row.originatingAlert) as NormalizedAlert)
        : null,
    sessionTrigger: row.sessionTrigger as SessionTrigger,
  };
}

export function insertInterrupt(interrupt: PendingInterrupt): void {
  getDb()
    .prepare(
      `INSERT INTO pending_interrupts
         (id, session_id, tool_use_id, kind, tool_name, tool_input, completed_results, created_at)
       VALUES
         (@id, @sessionId, @toolUseId, @kind, @toolName, @toolInput, @completedResults, @createdAt)`,
    )
    .run({
      id: interrupt.id,
      sessionId: interrupt.sessionId,
      toolUseId: interrupt.toolUseId,
      kind: interrupt.kind,
      toolName: interrupt.toolName,
      toolInput: JSON.stringify(interrupt.toolInput),
      completedResults: JSON.stringify(interrupt.completedResults),
      createdAt: interrupt.createdAt,
    });
}

// Returns true if the row existed and was deleted. false means it was already
// gone — the caller should return 409 (concurrency guard: delete is atomic).
export function deleteInterrupt(id: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM pending_interrupts WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

export function getInterruptWithSession(
  id: string,
): PendingInterruptWithSession | undefined {
  const row = getDb()
    .prepare(
      `SELECT pi.id, pi.session_id AS sessionId, pi.tool_use_id AS toolUseId,
              pi.kind, pi.tool_name AS toolName, pi.tool_input AS toolInput,
              pi.completed_results AS completedResults, pi.created_at AS createdAt,
              s.token, s.originating_alert AS originatingAlert, s.trigger AS sessionTrigger
       FROM pending_interrupts pi
       JOIN sessions s ON s.session_id = pi.session_id
       WHERE pi.id = ?`,
    )
    .get(id) as RawRowWithSession | undefined;
  return row ? parseRowWithSession(row) : undefined;
}

export function listInterruptsByToken(
  token: string,
): PendingInterruptWithSession[] {
  const rows = getDb()
    .prepare(
      `SELECT pi.id, pi.session_id AS sessionId, pi.tool_use_id AS toolUseId,
              pi.kind, pi.tool_name AS toolName, pi.tool_input AS toolInput,
              pi.completed_results AS completedResults, pi.created_at AS createdAt,
              s.token, s.originating_alert AS originatingAlert, s.trigger AS sessionTrigger
       FROM pending_interrupts pi
       JOIN sessions s ON s.session_id = pi.session_id
       WHERE s.token = ?`,
    )
    .all(token) as RawRowWithSession[];
  return rows.map(parseRowWithSession);
}

export function listAllInterrupts(): PendingInterruptWithSession[] {
  const rows = getDb()
    .prepare(
      `SELECT pi.id, pi.session_id AS sessionId, pi.tool_use_id AS toolUseId,
              pi.kind, pi.tool_name AS toolName, pi.tool_input AS toolInput,
              pi.completed_results AS completedResults, pi.created_at AS createdAt,
              s.token, s.originating_alert AS originatingAlert, s.trigger AS sessionTrigger
       FROM pending_interrupts pi
       JOIN sessions s ON s.session_id = pi.session_id`,
    )
    .all() as RawRowWithSession[];
  return rows.map(parseRowWithSession);
}

// Dedup: true if a session for this alert is durably suspended.
export function hasPendingInterruptForAlert(
  token: string,
  sourceAlertId: string,
): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM pending_interrupts pi
       JOIN sessions s ON s.session_id = pi.session_id
       WHERE s.token = ?
         AND json_extract(s.originating_alert, '$.sourceAlertId') = ?
       LIMIT 1`,
    )
    .get(token, sourceAlertId);
  return row != null;
}

// 409 guard: true if this session has a pending interrupt row.
export function hasPendingInterrupt(sessionId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM pending_interrupts WHERE session_id = ? LIMIT 1`)
    .get(sessionId);
  return row != null;
}
