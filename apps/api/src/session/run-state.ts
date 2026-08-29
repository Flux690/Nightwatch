import { getDb } from "../db.js";
import { deriveStatus, refreshSessionStatus } from "./status.js";

// The conditional UPDATE is the whole mutex: two racing dispatches attempt it
// and one changes a row. Every status but 'running' is claimable, since a
// finished session takes a new message and a gated one resumes.
export function claimRun(sessionId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE sessions SET status = 'running', stopped_at = NULL
       WHERE session_id = ? AND status <> 'running'`,
    )
    .run(sessionId);
  return result.changes > 0;
}

// Nothing else can say so afterwards, and calling a stopped run inconclusive
// blames the agent for a decision the user made.

export function markStopped(sessionId: string): void {
  getDb()
    .prepare(`UPDATE sessions SET stopped_at = ? WHERE session_id = ?`)
    .run(new Date().toISOString(), sessionId);
  // stopped_at is one of the columns the status is derived from. A no-op on the
  // ordinary path, where releaseRun settles the same answer moments later.
  refreshSessionStatus(sessionId);
}

// Conditional on 'running' so it cannot overwrite the 'action_required' written
// with the interrupt row: that session is waiting, not idle, and keeps its seat.
export function releaseRun(sessionId: string): void {
  getDb()
    .prepare(
      `UPDATE sessions SET status = ?
       WHERE session_id = ? AND status = 'running'`,
    )
    .run(deriveStatus(sessionId), sessionId);
}

// Recorded at the failure, because describeLLMError's prose cannot be
// classified afterwards and a bad key must never be retried.

export function recordRunFailure(
  sessionId: string,
  kind: "transient" | "permanent",
): void {
  getDb()
    .prepare(
      `UPDATE sessions
       SET failure_kind = @kind, failed_attempts = failed_attempts + 1
       WHERE session_id = @sessionId`,
    )
    .run({ sessionId, kind });
}

// A run that got somewhere clears the record, so a later unrelated failure gets
// its own three attempts rather than inheriting a spent count.
export function clearRunFailure(sessionId: string): void {
  getDb()
    .prepare(
      `UPDATE sessions SET failure_kind = NULL, failed_attempts = 0
       WHERE session_id = ? AND failure_kind IS NOT NULL`,
    )
    .run(sessionId);
}

export function runFailure(
  sessionId: string,
): { kind: string; attempts: number } | undefined {
  const row = getDb()
    .prepare(
      `SELECT failure_kind AS kind, failed_attempts AS attempts
       FROM sessions WHERE session_id = ? AND failure_kind IS NOT NULL`,
    )
    .get(sessionId) as { kind: string; attempts: number } | undefined;
  return row;
}

/* Unconditional, unlike releaseRun: boot recovery uses it to give back a seat
   held by a session waiting on nobody, which releaseRun deliberately will not
   touch because that session is not running. */

export function markDone(sessionId: string): void {
  getDb()
    .prepare(`UPDATE sessions SET status = ? WHERE session_id = ?`)
    .run(deriveStatus(sessionId), sessionId);
}

export function isRunning(sessionId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM sessions
       WHERE session_id = ? AND status = 'running' LIMIT 1`,
    )
    .get(sessionId);
  return row !== undefined;
}

// One rule for both pools: running or waiting on a human holds a seat. Freeing
// the seat of a gated session only queues a second request behind that person.

export function countSeats(investigation: boolean): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS taken FROM sessions
       WHERE investigation = ? AND status IN ('running', 'action_required')`,
    )
    .get(investigation ? 1 : 0) as { taken: number };
  return row.taken;
}

// Approving clears the gate before the resume claims the run, so a crash in
// that gap leaves a session waiting on nobody, holding a seat.
export function abandonedSessionIds(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id AS sessionId FROM sessions
       WHERE status = 'action_required'`,
    )
    .all() as Array<{ sessionId: string }>;
  return rows.map((r) => r.sessionId);
}

// Read once at boot, where every one of them is a run this process cannot be
// running: it has only just started.
export function runningSessionIds(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id AS sessionId FROM sessions WHERE status = 'running'`,
    )
    .all() as Array<{ sessionId: string }>;
  return rows.map((r) => r.sessionId);
}
