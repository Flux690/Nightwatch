import type {
  RemediationActionRecord,
  RemediationStatus,
} from "@nightwarden/shared";
import { getDb } from "./client.js";

export interface RemediationAction {
  id: number;
  toolUseId: string;
  sessionId: string;
  toolName: string;
  serviceIdentityKey: string | null;
  status: RemediationStatus;
  resolvedBy: string | null;
  input: string;
  result: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

// The tool input's target key, shared by the audit record write and the breaker count.
export function targetKeyFromInput(
  input: Record<string, unknown>,
): string | null {
  const target = input["target"];
  return typeof target === "string" ? target : null;
}

// Durable audit record, so the ceiling is high; eviction only drops rows far
// older than any breaker window.
const MAX_REMEDIATION_ACTIONS = 10000;

function pruneRemediationActions(): void {
  getDb()
    .prepare(
      `DELETE FROM remediation_actions
       WHERE id < (SELECT MIN(id) FROM (SELECT id FROM remediation_actions ORDER BY id DESC LIMIT @cap))`,
    )
    .run({ cap: MAX_REMEDIATION_ACTIONS });
}

// Returns false when the UNIQUE constraint fires, meaning the action was
// already attempted (crash recovery) and must not run again.
export function insertExecutingRemediationAction(params: {
  toolUseId: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolvedBy: string;
}): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO remediation_actions
           (tool_use_id, session_id, tool_name, service_identity_key, status, resolved_by, input, created_at)
         VALUES
           (@toolUseId, @sessionId, @toolName, @identityKey, 'executing', @resolvedBy, @input, @createdAt)`,
      )
      .run({
        toolUseId: params.toolUseId,
        sessionId: params.sessionId,
        toolName: params.toolName,
        identityKey: targetKeyFromInput(params.input),
        resolvedBy: params.resolvedBy,
        input: JSON.stringify(params.input),
        createdAt: new Date().toISOString(),
      });
    pruneRemediationActions();
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("UNIQUE constraint failed")
    ) {
      return false;
    }
    throw err;
  }
}

// Called after the runner responds: transition 'executing' → 'executed'|'failed'.
export function settleRemediationAction(
  sessionId: string,
  toolUseId: string,
  status: "executed" | "failed",
  result: unknown,
): void {
  const serialised =
    typeof result === "string" ? result : JSON.stringify(result);
  getDb()
    .prepare(
      `UPDATE remediation_actions
       SET status = @status, result = @result, resolved_at = @resolvedAt
       WHERE session_id = @sessionId AND tool_use_id = @toolUseId`,
    )
    .run({
      sessionId,
      toolUseId,
      status,
      result: serialised,
      resolvedAt: new Date().toISOString(),
    });
}

// Idempotent: a re-rejected interrupt after a crash is ignored, not a constraint
// error. Returns false when OR IGNORE fired.
export function insertRejectedRemediationAction(params: {
  toolUseId: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolvedBy: string;
}): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO remediation_actions
         (tool_use_id, session_id, tool_name, service_identity_key, status, resolved_by, input, created_at, resolved_at)
       VALUES
         (@toolUseId, @sessionId, @toolName, @identityKey, 'rejected', @resolvedBy, @input, @createdAt, @resolvedAt)`,
    )
    .run({
      toolUseId: params.toolUseId,
      sessionId: params.sessionId,
      toolName: params.toolName,
      identityKey: targetKeyFromInput(params.input),
      resolvedBy: params.resolvedBy,
      input: JSON.stringify(params.input),
      createdAt: now,
      resolvedAt: now,
    });
  if (result.changes > 0) pruneRemediationActions();
  return result.changes > 0;
}

// Column list shared by every reader so the row shape can't drift between
// a single lookup and the audit list.
const SELECT_COLUMNS = `
  id,
  tool_use_id           AS toolUseId,
  session_id            AS sessionId,
  tool_name             AS toolName,
  service_identity_key  AS serviceIdentityKey,
  status,
  resolved_by           AS resolvedBy,
  input,
  result,
  created_at            AS createdAt,
  resolved_at           AS resolvedAt
`;

export function findRemediationAction(
  sessionId: string,
  toolUseId: string,
): RemediationAction | undefined {
  return getDb()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM remediation_actions WHERE session_id = ? AND tool_use_id = ?`,
    )
    .get(sessionId, toolUseId) as RemediationAction | undefined;
}

// Every decision made in one session, for rebuilding its transcript after a reload.
export function listRemediationActionsForSession(
  sessionId: string,
): RemediationAction[] {
  return getDb()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM remediation_actions WHERE session_id = ?`,
    )
    .all(sessionId) as RemediationAction[];
}

// Newest first, capped like listAllSessions: the audit view reads top-to-bottom
// as "most recent activity", not a full unbounded export.
export function listRemediationActions(): RemediationAction[] {
  return getDb()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM remediation_actions ORDER BY created_at DESC LIMIT 100`,
    )
    .all() as RemediationAction[];
}

// What the approval card reports back to the human: how many times this exact write
// already landed recently. Counts only 'executed' - a rejected or failed attempt
// changed nothing, so it is not something the operator is repeating.
export function countExecutedRemediations(params: {
  serviceIdentityKey: string;
  toolName: string;
  since: string;
}): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
       FROM remediation_actions
       WHERE service_identity_key = @serviceIdentityKey
         AND tool_name = @toolName
         AND status = 'executed'
         AND created_at >= @since`,
    )
    .get(params) as { count: number };
  return row.count;
}

// Row to wire shape. Shared by the audit log and the session report so the two
// views of one action can never drift apart.
export function toActionRecord(
  action: RemediationAction,
): RemediationActionRecord {
  return {
    sessionId: action.sessionId,
    toolUseId: action.toolUseId,
    serviceIdentityKey: action.serviceIdentityKey,
    toolName: action.toolName,
    status: action.status,
    resolvedBy: action.resolvedBy,
    createdAt: action.createdAt,
    resolvedAt: action.resolvedAt,
  };
}
