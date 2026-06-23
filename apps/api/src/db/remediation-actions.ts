import { serviceIdentityKey, type ServiceIdentity } from "@nightwatch/shared";
import { getDb } from "./client.js";

export type RemediationStatus =
  | "executing"
  | "executed"
  | "failed"
  | "rejected";

export interface RemediationAction {
  id: number;
  toolUseId: string;
  sessionId: string;
  toolName: string;
  serviceIdentityKey: string | null;
  status: RemediationStatus;
  input: string;
  result: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

function extractIdentityKey(input: Record<string, unknown>): string | null {
  const service = input["service"];
  if (
    typeof service !== "object" ||
    service === null ||
    !("provider" in service)
  ) {
    return null;
  }
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
}): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO remediation_actions
           (tool_use_id, session_id, tool_name, service_identity_key, status, input, created_at)
         VALUES
           (@toolUseId, @sessionId, @toolName, @identityKey, 'executing', @input, @createdAt)`,
      )
      .run({
        toolUseId: params.toolUseId,
        sessionId: params.sessionId,
        toolName: params.toolName,
        identityKey: extractIdentityKey(params.input),
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
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO remediation_actions
         (tool_use_id, session_id, tool_name, service_identity_key, status, input, created_at, resolved_at)
       VALUES
         (@toolUseId, @sessionId, @toolName, @identityKey, 'rejected', @input, @createdAt, @resolvedAt)`,
    )
    .run({
      toolUseId: params.toolUseId,
      sessionId: params.sessionId,
      toolName: params.toolName,
      identityKey: extractIdentityKey(params.input),
      input: JSON.stringify(params.input),
      createdAt: now,
      resolvedAt: now,
    });
}

export function findRemediationAction(
  toolUseId: string,
): RemediationAction | undefined {
  return getDb()
    .prepare(
      `SELECT
         id,
         tool_use_id      AS toolUseId,
         session_id       AS sessionId,
         tool_name        AS toolName,
         service_identity_key AS serviceIdentityKey,
         status,
         input,
         result,
         created_at       AS createdAt,
         resolved_at      AS resolvedAt
       FROM remediation_actions
       WHERE tool_use_id = ?`,
    )
    .get(toolUseId) as RemediationAction | undefined;
}
