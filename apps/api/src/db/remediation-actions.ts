import {
  serviceIdentityKey,
  type RemediationStatus,
  type ServiceIdentity,
} from "@nightwatch/shared";
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

// Derives the canonical identity key from a tool input's `service`, or null when it carries
// none. The single place input becomes a key, shared by the record write and the breaker
// count so both key the same shape.
export function serviceIdentityKeyFromInput(
  input: Record<string, unknown>,
): string | null {
  const service = input["service"];
  if (
    typeof service !== "object" ||
    service === null ||
    !("provider" in service)
  ) {
    return null;
  }
  // The runner validates the live identity; here we only need its canonical key.
  return serviceIdentityKey(service as ServiceIdentity);
}

// Audit-log retention ceiling: the breaker reads only a recent window and the list shows
// 100, but this is the durable record, so the ceiling is high and eviction only drops rows
// far older than any breaker window.
const MAX_REMEDIATION_ACTIONS = 10000;

function pruneRemediationActions(): void {
  getDb()
    .prepare(
      `DELETE FROM remediation_actions
       WHERE id < (SELECT MIN(id) FROM (SELECT id FROM remediation_actions ORDER BY id DESC LIMIT @cap))`,
    )
    .run({ cap: MAX_REMEDIATION_ACTIONS });
}

// Write-ahead insert for an approved action. Returns false when the UNIQUE
// constraint fires — meaning the action was already attempted (crash-recovery
// scenario) and must not run again.
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
        identityKey: serviceIdentityKeyFromInput(params.input),
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

// One-shot, idempotent rejection insert: a re-rejected interrupt after a crash is ignored,
// not a constraint error. Returns false when OR IGNORE fired (the caller warns on the
// executing-row zombie case).
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
      identityKey: serviceIdentityKeyFromInput(params.input),
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

// Newest first, capped like listAllSessions: the audit view reads top-to-bottom
// as "most recent activity", not a full unbounded export.
export function listRemediationActions(): RemediationAction[] {
  return getDb()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM remediation_actions ORDER BY created_at DESC LIMIT 100`,
    )
    .all() as RemediationAction[];
}

// Counts SUCCEEDED writes (status 'executed') to the same (identity, action) since `since`,
// for the breaker. A 'failed' write doesn't count - a transient failure must not burn the
// budget; 'rejected'/'executing' aren't successes either.
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
