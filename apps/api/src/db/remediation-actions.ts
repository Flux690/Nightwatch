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

// Derives the canonical identity key from a tool input's `service` block, or
// null when the tool carries no service identity. The single place a tool input
// is turned into an identity key, shared by the record write and the breaker
// count so both key on exactly the same shape.
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
       WHERE tool_use_id = @toolUseId`,
    )
    .run({
      toolUseId,
      status,
      result: serialised,
      resolvedAt: new Date().toISOString(),
    });
}

// One-shot insert for a rejection — no executing→executed cycle needed.
export function insertRejectedRemediationAction(params: {
  toolUseId: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolvedBy: string;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO remediation_actions
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
  toolUseId: string,
): RemediationAction | undefined {
  return getDb()
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM remediation_actions WHERE tool_use_id = ?`,
    )
    .get(toolUseId) as RemediationAction | undefined;
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

// Counts writes to the same service identity and action that actually reached
// the infrastructure (executed or failed) since `since`. Drives the circuit
// breaker: a 'rejected' or still-'executing' row is not a landed write and does
// not count. Keyed on the canonical identity key, so a server-scoped identity
// refines the count for free.
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
         AND status IN ('executed', 'failed')
         AND created_at >= @since`,
    )
    .get(params) as { count: number };
  return row.count;
}
