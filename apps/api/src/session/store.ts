import type {
  InvestigationRecord,
  InvestigationStatus,
  SessionAlert,
  SessionKind,
  SessionMeta,
} from "@nightwarden/shared";
import { getDb } from "../db.js";
import { assembleRecord } from "./record.js";
import { alertsFor, alertsForMany, QUEUED } from "./alerts-store.js";
import { isHumanInputKind, type PendingHumanInput } from "./interrupts.js";

// The alerts are the durable source of severity-dependent behavior on resume, so
// a run that no longer carries them in its job can recover them from here.
type StoredSession = SessionMeta & {
  alerts: SessionAlert[];
  investigation: boolean;
  lastActivityAt: string;
};

const INSERT_SESSION = `INSERT INTO sessions
     (session_id, title, investigation, created_at, last_activity_at)
   VALUES (@sessionId, @title, @investigation, @createdAt, @createdAt)
   ON CONFLICT(session_id) DO NOTHING`;

// Create the session row once. Idempotent: a resume re-enters the loop with the
// same id, and the first title wins - later runs never clobber it.
export function createSession(meta: SessionMeta, investigation = false): void {
  getDb()
    .prepare(INSERT_SESSION)
    .run({
      sessionId: meta.sessionId,
      title: meta.title,
      investigation: investigation ? 1 : 0,
      createdAt: meta.createdAt,
    });
}

/* Creates the session and takes the group's queued alerts in one transaction. A
   crash between the two would otherwise leave alerts pointing at a session
   nothing wrote, or a session covering nothing. */
export function openSessionForGroup(meta: SessionMeta, groupKey: string): void {
  const db = getDb();
  const insertSession = db.prepare(INSERT_SESSION);
  const assign = db.prepare(
    `UPDATE alerts SET session_id = @sessionId
     WHERE group_key = @groupKey AND ${QUEUED}`,
  );
  db.transaction((): void => {
    insertSession.run({
      sessionId: meta.sessionId,
      title: meta.title,
      investigation: 1,
      createdAt: meta.createdAt,
    });
    assign.run({ sessionId: meta.sessionId, groupKey });
  })();
}

// Overwrites unconditionally: the refined title deliberately replaces the
// temporary first-message title once the run has generated it.
export function updateSessionTitle(sessionId: string, title: string): void {
  getDb()
    .prepare(`UPDATE sessions SET title = ? WHERE session_id = ?`)
    .run(title, sessionId);
}

// Takes the record columns and the gate with them, and cascades to the transcript.
// Nothing about a session outlives it.
export function deleteSession(sessionId: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
}

// Raw material for the sessions queue: one row per session, its record and the
// transcript's tail. The status is read, not computed - session/status.ts wrote
// it on the transition that made it true.
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
  hypotheses: string;
  report: string | null;
  recordUpdatedAt: string | null;
  lastContent: string | null;
  awaitingHumanInput: number;
  pendingKind: string | null;
}

const LIST_COLUMNS = `s.session_id AS sessionId, s.title, s.created_at AS createdAt,
        s.investigation, s.status, s.hypotheses, s.report,
        s.record_updated_at AS recordUpdatedAt,
        (SELECT m.content FROM session_transcript m
          WHERE m.session_id = s.session_id
          ORDER BY m.seq DESC LIMIT 1) AS lastContent,
        s.last_activity_at AS lastActivityAt,
        (s.awaiting_tool_use_id IS NOT NULL) AS awaitingHumanInput,
        s.awaiting_kind AS pendingKind`;

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
        hypotheses: r.hypotheses,
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
export function listSessionFacts(
  limit: number,
  offset: number,
  kind?: SessionKind,
): SessionListFactsPage {
  const filter =
    kind === undefined
      ? ""
      : `WHERE s.investigation = ${kind === "investigation" ? 1 : 0}`;
  const rows = getDb()
    .prepare(
      // No join any more: whether a session awaits a human is a column on its own
      // row, which is also the leading key of the sort below.
      `SELECT ${LIST_COLUMNS}
       FROM sessions s
       ${filter}
       ORDER BY awaitingHumanInput DESC, lastActivityAt DESC, s.session_id ASC
       LIMIT ? OFFSET ?`,
    )
    // One extra row answers "is there a next page?" without a second count query.
    .all(limit + 1, offset) as SessionListRawRow[];
  const page = rows.slice(0, limit);
  const alerts = alertsForMany(page.map((r) => r.sessionId));
  return {
    facts: page.map((r) => toFacts(r, alerts.get(r.sessionId) ?? [])),
    nextOffset: rows.length > limit ? offset + page.length : null,
  };
}

// A claim about the whole set, which no page of rows can answer. It is a
// count, so it is counted rather than loaded and measured.
export function countInvestigations(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS total FROM sessions WHERE investigation = 1`)
    .get() as { total: number };
  return row.total;
}

// Whether the row is there, for callers that only need it to exist. Kept apart
// from getSession so an existence check never pays for the alerts.
export function sessionExists(sessionId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM sessions WHERE session_id = ? LIMIT 1`)
    .get(sessionId);
  return row !== undefined;
}

export function getSession(sessionId: string): StoredSession | undefined {
  const row = getDb()
    .prepare(
      `SELECT session_id AS sessionId, title, investigation,
              created_at AS createdAt, last_activity_at AS lastActivityAt
       FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as
    | (SessionMeta & { investigation: number; lastActivityAt: string })
    | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.sessionId,
    title: row.title,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    investigation: row.investigation === 1,
    alerts: alertsFor(sessionId),
  };
}
