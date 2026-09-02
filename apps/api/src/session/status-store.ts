import type { InvestigationStatus } from "@nightwarden/shared";
import { sql } from "kysely";
import { getDb, type Db } from "../db.js";

// `running` is the one value no stored row can confirm, so it is claimed by a
// conditional UPDATE that doubles as the dispatch mutex.

// The counts are nullable because a correlated subquery may return no row.
// COUNT always does, so they read as zero rather than being asserted away.
interface StatusFacts {
  gated: number;
  stoppedAt: string | null;
  alerts: number | null;
  openAlerts: number | null;
  lastKind: string | null;
}

function facts(db: Db, sessionId: string): Promise<StatusFacts | undefined> {
  return db
    .selectFrom("sessions as s")
    .where("s.session_id", "=", sessionId)
    .select((eb) => [
      sql<number>`(s.awaiting_tool_use_id IS NOT NULL)`.as("gated"),
      "s.stopped_at as stoppedAt",
      eb
        .selectFrom("alerts as a")
        .whereRef("a.session_id", "=", "s.session_id")
        .select(eb.fn.countAll<number>().as("c"))
        .as("alerts"),
      eb
        .selectFrom("alerts as a")
        .whereRef("a.session_id", "=", "s.session_id")
        .where("a.cleared_at", "is", null)
        .select(eb.fn.countAll<number>().as("c"))
        .as("openAlerts"),
      eb
        .selectFrom("session_transcript as m")
        .whereRef("m.session_id", "=", "s.session_id")
        .select("m.kind")
        .orderBy("m.seq", "desc")
        .limit(1)
        .as("lastKind"),
    ])
    .executeTakeFirst();
}

// The order is the meaning: a gate leads because someone is being asked
// something now, and a recovered incident outranks who ended the run.
function statusFrom(f: StatusFacts): InvestigationStatus {
  if (f.gated === 1) return "action_required";
  // A session that fired on no alert has no condition to recover, so the alert
  // count is checked as well as the open count.
  if ((f.alerts ?? 0) > 0 && (f.openAlerts ?? 0) === 0) return "resolved";
  if (f.stoppedAt !== null) return "stopped";
  if (f.lastKind === "error") return "failed";
  return "completed";
}

export async function deriveStatus(
  sessionId: string,
  db: Db = getDb(),
): Promise<InvestigationStatus> {
  const f = await facts(db, sessionId);
  return f === undefined ? "completed" : statusFrom(f);
}

// Guarded, so a transition elsewhere cannot pull a live run out of `running`.
export async function refreshSessionStatus(
  sessionId: string,
  db: Db = getDb(),
): Promise<void> {
  await db
    .updateTable("sessions")
    .set({ status: await deriveStatus(sessionId, db) })
    .where("session_id", "=", sessionId)
    .where("status", "!=", "running")
    .execute();
}

// The conditional UPDATE is the whole mutex: two racing dispatches attempt it
// and one changes a row. Every status but 'running' is claimable.
export async function claimRun(sessionId: string): Promise<boolean> {
  const res = await getDb()
    .updateTable("sessions")
    .set({ status: "running", stopped_at: null })
    .where("session_id", "=", sessionId)
    .where("status", "!=", "running")
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

// Recorded when it happens, because a stopped run reaches the same end as one
// that ran out of ideas and blaming the agent is a different claim.
export async function markStopped(sessionId: string): Promise<void> {
  await getDb()
    .updateTable("sessions")
    .set({ stopped_at: new Date().toISOString() })
    .where("session_id", "=", sessionId)
    .execute();
  await refreshSessionStatus(sessionId);
}

// Conditional on 'running' so it cannot overwrite the 'action_required' written
// with the interrupt row: that session is waiting, not idle, and keeps its seat.
export async function releaseRun(sessionId: string): Promise<void> {
  await getDb()
    .updateTable("sessions")
    .set({ status: await deriveStatus(sessionId) })
    .where("session_id", "=", sessionId)
    .where("status", "=", "running")
    .execute();
}

// Recorded at the failure, because describeLLMError's prose cannot be
// classified afterwards and a bad key must never be retried.
export async function recordRunFailure(
  sessionId: string,
  kind: "transient" | "permanent",
): Promise<void> {
  await getDb()
    .updateTable("sessions")
    .set((eb) => ({
      failure_kind: kind,
      failed_attempts: eb("failed_attempts", "+", 1),
    }))
    .where("session_id", "=", sessionId)
    .execute();
}

// A run that got somewhere clears the record, so a later unrelated failure gets
// its own three attempts rather than inheriting a spent count.
export async function clearRunFailure(sessionId: string): Promise<void> {
  await getDb()
    .updateTable("sessions")
    .set({ failure_kind: null, failed_attempts: 0 })
    .where("session_id", "=", sessionId)
    .where("failure_kind", "is not", null)
    .execute();
}

export async function runFailure(
  sessionId: string,
): Promise<{ kind: string; attempts: number } | undefined> {
  const row = await getDb()
    .selectFrom("sessions")
    .select(["failure_kind as kind", "failed_attempts as attempts"])
    .where("session_id", "=", sessionId)
    .where("failure_kind", "is not", null)
    .executeTakeFirst();
  return row?.kind == null
    ? undefined
    : { kind: row.kind, attempts: row.attempts };
}

/* Unconditional, unlike releaseRun: boot recovery gives back a seat held by a
   session waiting on nobody, which releaseRun leaves alone. */
export async function markDone(sessionId: string): Promise<void> {
  await getDb()
    .updateTable("sessions")
    .set({ status: await deriveStatus(sessionId) })
    .where("session_id", "=", sessionId)
    .execute();
}

export async function isRunning(sessionId: string): Promise<boolean> {
  const row = await getDb()
    .selectFrom("sessions")
    .select("session_id")
    .where("session_id", "=", sessionId)
    .where("status", "=", "running")
    .executeTakeFirst();
  return row !== undefined;
}

// One rule for both pools: running or waiting on a human holds a seat. Freeing
// the seat of a gated session only queues a second request behind that person.
export async function countSeats(investigation: boolean): Promise<number> {
  const row = await getDb()
    .selectFrom("sessions")
    .select((eb) => eb.fn.countAll<number>().as("taken"))
    .where("investigation", "=", investigation ? 1 : 0)
    .where("status", "in", ["running", "action_required"])
    .executeTakeFirst();
  return row?.taken ?? 0;
}

// Approving clears the gate before the resume claims the run, so a crash in
// that gap leaves a session waiting on nobody, holding a seat.
export async function abandonedSessionIds(): Promise<string[]> {
  const rows = await getDb()
    .selectFrom("sessions")
    .select("session_id as sessionId")
    .where("status", "=", "action_required")
    .execute();
  return rows.map((r) => r.sessionId);
}

// Read once at boot, where every one of them is a run this process cannot be
// running: it has only just started.
export async function runningSessionIds(): Promise<string[]> {
  const rows = await getDb()
    .selectFrom("sessions")
    .select("session_id as sessionId")
    .where("status", "=", "running")
    .execute();
  return rows.map((r) => r.sessionId);
}
