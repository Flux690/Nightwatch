import type {
  InvestigationRecord,
  InvestigationStatus,
  SessionAlert,
  SessionKind,
  SessionMeta,
} from "@nightwarden/shared";
import { sql } from "kysely";
import { getDb } from "../db.js";
import { assembleRecord } from "./record-store.js";
import { alertsFor, alertsForMany, isQueued } from "./alerts-store.js";
import { isHumanInputKind, type PendingHumanInput } from "./gate-store.js";

// The alerts are the durable source of severity-dependent behavior on resume, so
// a run that no longer carries them in its job can recover them from here.
type StoredSession = SessionMeta & {
  alerts: SessionAlert[];
  investigation: boolean;
  lastActivityAt: string;
};

// Create the session row once. Idempotent: a resume re-enters the loop with the
// same id, and the first title wins - later runs never clobber it.
export async function createSession(
  meta: SessionMeta,
  investigation = false,
): Promise<void> {
  await getDb()
    .insertInto("sessions")
    .values({
      session_id: meta.sessionId,
      title: meta.title,
      investigation: investigation ? 1 : 0,
      created_at: meta.createdAt,
      last_activity_at: meta.createdAt,
    })
    .onConflict((oc) => oc.column("session_id").doNothing())
    .execute();
}

/* One transaction, so a crash between the two cannot leave alerts pointing at a
   session nothing wrote, or a session covering nothing. */
export async function openSessionForGroup(
  meta: SessionMeta,
  groupKey: string,
): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (trx) => {
      await trx
        .insertInto("sessions")
        .values({
          session_id: meta.sessionId,
          title: meta.title,
          investigation: 1,
          created_at: meta.createdAt,
          last_activity_at: meta.createdAt,
        })
        .onConflict((oc) => oc.column("session_id").doNothing())
        .execute();
      await trx
        .updateTable("alerts")
        .set({ session_id: meta.sessionId })
        .where("group_key", "=", groupKey)
        .where(isQueued)
        .execute();
    });
}

// Overwrites unconditionally: the refined title deliberately replaces the
// temporary first-message title once the run has generated it.
export async function updateSessionTitle(
  sessionId: string,
  title: string,
): Promise<void> {
  await getDb()
    .updateTable("sessions")
    .set({ title })
    .where("session_id", "=", sessionId)
    .execute();
}

// Takes the record columns and the gate with them, and cascades to the transcript.
// Nothing about a session outlives it.
export async function deleteSession(sessionId: string): Promise<void> {
  await getDb()
    .deleteFrom("sessions")
    .where("session_id", "=", sessionId)
    .execute();
}

// Raw material for the sessions queue. The status is read rather than computed:
// the transition that made it true wrote it.
export interface SessionListFacts {
  sessionId: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  alerts: SessionAlert[];
  investigation: boolean;
  status: InvestigationStatus;
  record: InvestigationRecord | null;
  // The tail's text, which is why a failed run failed when the status is failed.
  lastContent: string | null;
  awaitingHumanInput: boolean;
  // What the session is waiting on, null when it waits on nothing.
  pendingKind: PendingHumanInput["kind"] | null;
}

// One page of it. nextOffset is the offset to ask for next, or null once the
// list is exhausted.
interface SessionListFactsPage {
  facts: SessionListFacts[];
  nextOffset: number | null;
}

interface SessionListRawRow {
  sessionId: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  investigation: number;
  status: string;
  candidates: string;
  findings: string;
  lastStatedCandidates: string;
  report: string | null;
  recordUpdatedAt: string | null;
  lastContent: string | null;
  awaitingHumanInput: number;
  pendingKind: string | null;
}

// The status cast is safe because the column CHECKs against the same members.
function toFacts(
  r: SessionListRawRow,
  alerts: SessionAlert[],
): SessionListFacts {
  return {
    sessionId: r.sessionId,
    title: r.title,
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
    alerts,
    investigation: r.investigation === 1,
    status: r.status as InvestigationStatus,
    record:
      assembleRecord({
        candidates: r.candidates,
        findings: r.findings,
        lastStatedCandidates: r.lastStatedCandidates,
        report: r.report,
        updatedAt: r.recordUpdatedAt,
      }) ?? null,
    lastContent: r.lastContent,
    awaitingHumanInput: r.awaitingHumanInput === 1,
    pendingKind:
      r.pendingKind !== null && isHumanInputKind(r.pendingKind)
        ? r.pendingKind
        : null,
  };
}

// Ordering is the store's, not the frontend's: a waiting session leads the whole
// list, and the id tiebreak stops a row swapping pages between fetches.
export async function listSessionFacts(
  limit: number,
  offset: number,
  kind: SessionKind,
): Promise<SessionListFactsPage> {
  const rows = await getDb()
    .selectFrom("sessions as s")
    .select((eb) => [
      "s.session_id as sessionId",
      "s.title",
      "s.created_at as createdAt",
      "s.investigation",
      "s.status",
      "s.candidates",
      "s.findings",
      "s.last_stated_candidates as lastStatedCandidates",
      "s.report",
      "s.record_updated_at as recordUpdatedAt",
      eb
        .selectFrom("session_transcript as m")
        .whereRef("m.session_id", "=", "s.session_id")
        .select("m.content")
        .orderBy("m.seq", "desc")
        .limit(1)
        .as("lastContent"),
      "s.last_activity_at as lastActivityAt",
      sql<number>`(s.awaiting_tool_use_id IS NOT NULL)`.as(
        "awaitingHumanInput",
      ),
      "s.awaiting_kind as pendingKind",
    ])
    .where("s.investigation", "=", kind === "investigation" ? 1 : 0)
    .orderBy(sql`(s.awaiting_tool_use_id IS NOT NULL)`, "desc")
    .orderBy("s.last_activity_at", "desc")
    .orderBy("s.session_id", "asc")
    // One extra row answers "is there a next page?" without a second count.
    .limit(limit + 1)
    .offset(offset)
    .execute();
  const page = rows.slice(0, limit);
  const alerts = await alertsForMany(page.map((r) => r.sessionId));
  return {
    facts: page.map((r) => toFacts(r, alerts.get(r.sessionId) ?? [])),
    nextOffset: rows.length > limit ? offset + page.length : null,
  };
}

// A claim about the whole set, which no page of rows can answer. It is a
// count, so it is counted rather than loaded and measured.
export async function countInvestigations(): Promise<number> {
  const row = await getDb()
    .selectFrom("sessions")
    .select((eb) => eb.fn.countAll<number>().as("total"))
    .where("investigation", "=", 1)
    .executeTakeFirst();
  return row?.total ?? 0;
}

// Whether the row is there, for callers that only need it to exist. Kept apart
// from getSession so an existence check never pays for the alerts.
export async function sessionExists(sessionId: string): Promise<boolean> {
  const row = await getDb()
    .selectFrom("sessions")
    .select("session_id")
    .where("session_id", "=", sessionId)
    .executeTakeFirst();
  return row !== undefined;
}

export async function getSession(
  sessionId: string,
): Promise<StoredSession | undefined> {
  const row = await getDb()
    .selectFrom("sessions")
    .select([
      "session_id as sessionId",
      "title",
      "investigation",
      "created_at as createdAt",
      "last_activity_at as lastActivityAt",
    ])
    .where("session_id", "=", sessionId)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    sessionId: row.sessionId,
    title: row.title,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    investigation: row.investigation === 1,
    alerts: await alertsFor(sessionId),
  };
}
