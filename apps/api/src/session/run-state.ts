import { getDb } from "../db.js";

// The conditional UPDATE is the whole mutex: two racing dispatches attempt it
// and one changes a row. Claimable from 'suspended', which is a resume.
export function claimRun(sessionId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE sessions SET run_state = 'running', stopped_at = NULL
       WHERE session_id = ? AND run_state IN ('done', 'suspended')`,
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
}

// Conditional on 'running' so it cannot undo the 'suspended' written with the
// interrupt row: that session is waiting, not idle, and it keeps its seat.
export function releaseRun(sessionId: string): void {
  getDb()
    .prepare(
      `UPDATE sessions SET run_state = 'done'
       WHERE session_id = ? AND run_state = 'running'`,
    )
    .run(sessionId);
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
   held by a session suspended on nobody, which releaseRun deliberately will not
   touch because that session is not running. */

export function markDone(sessionId: string): void {
  getDb()
    .prepare(`UPDATE sessions SET run_state = 'done' WHERE session_id = ?`)
    .run(sessionId);
}

export function isRunning(sessionId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM sessions
       WHERE session_id = ? AND run_state = 'running' LIMIT 1`,
    )
    .get(sessionId);
  return row !== undefined;
}

/* An investigation holds a seat while suspended because the human it waits on is
   the scarce thing. A chat holds one only while working - someone was sitting
   right there when it started. */

export function countSeats(investigation: boolean): number {
  const states = investigation ? ["running", "suspended"] : ["running"];
  const holes = states.map(() => "?").join(", ");
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS taken FROM sessions
       WHERE investigation = ? AND run_state IN (${holes})`,
    )
    .get(investigation ? 1 : 0, ...states) as { taken: number };
  return row.taken;
}

// Approving deletes the interrupt row before the resume claims the run, so a
// crash in that gap leaves a session suspended forever, holding a seat.
export function suspendedSessionIds(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id AS sessionId FROM sessions
       WHERE run_state = 'suspended'`,
    )
    .all() as Array<{ sessionId: string }>;
  return rows.map((r) => r.sessionId);
}

// Read once at boot, where every one of them is a run this process cannot be
// running: it has only just started.
export function runningSessionIds(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id AS sessionId FROM sessions WHERE run_state = 'running'`,
    )
    .all() as Array<{ sessionId: string }>;
  return rows.map((r) => r.sessionId);
}
