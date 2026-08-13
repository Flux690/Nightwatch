import type {
  MessagePart,
  NativeEnvelope,
  NormalizedAlert,
  SessionAlert,
  Report,
  SessionKind,
  TranscriptRow,
  SessionMeta,
} from "@nightwarden/shared";
import { getDb } from "./client.js";
import { isHumanInputKind, type PendingHumanInput } from "./interrupts.js";

// The alerts are the durable source of severity-dependent behavior on resume, so
// a run that no longer carries them in its job can recover them from here.
type StoredSession = SessionMeta & {
  alerts: SessionAlert[];
  investigation: boolean;
};

const INSERT_ALERT = `INSERT INTO alerts
     (session_id, group_key, source_alert_id, fired_at, arrived_at, cleared_at,
      injected, dropped_alerts, alert)
   VALUES (@sessionId, @groupKey, @sourceAlertId, @firedAt, @arrivedAt, NULL,
      @injected, @droppedAlerts, @alert)`;

function alertParams(
  sessionId: string | null,
  groupKey: string,
  alert: NormalizedAlert,
  arrivedAt: string,
  injected: boolean,
  droppedAlerts: number,
): Record<string, string | number | null> {
  return {
    sessionId,
    groupKey,
    sourceAlertId: alert.sourceAlertId,
    firedAt: alert.firedAt,
    arrivedAt,
    injected: injected ? 1 : 0,
    droppedAlerts,
    alert: JSON.stringify(alert),
  };
}

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

/* One delivery's alerts, durable the moment we answer it 200 and before anything
   decides whether a seat is free. Owned by no session yet: what makes them one
   prospective investigation is the group key Alertmanager sent, not our timing. */
export function enqueueAlerts(
  groupKey: string,
  alerts: NormalizedAlert[],
  droppedAlerts = 0,
): void {
  if (alerts.length === 0) return;
  const db = getDb();
  const insert = db.prepare(INSERT_ALERT);
  const arrivedAt = new Date().toISOString();
  db.transaction((): void => {
    for (const alert of alerts) {
      insert.run(
        alertParams(null, groupKey, alert, arrivedAt, false, droppedAlerts),
      );
    }
  })();
}

// An alert that arrived while the run was already working. `arrivedAt` is what
// later places it in the transcript, at the turn it interrupted.
export function appendSessionAlert(
  sessionId: string,
  groupKey: string,
  alert: NormalizedAlert,
  droppedAlerts = 0,
): void {
  getDb()
    .prepare(INSERT_ALERT)
    .run(
      alertParams(
        sessionId,
        groupKey,
        alert,
        new Date().toISOString(),
        true,
        droppedAlerts,
      ),
    );
}

/* Stamps this alert wherever it is still open, queued rows included: an alert
   that recovers while waiting for a seat is cleared here and then never promoted,
   so nothing is investigated after the fact and no session is created to explain.
   The first clear wins per alert - a re-fire that clears again says nothing new. */
export function markAlertCleared(
  sourceAlertId: string,
  clearedAt: string,
): string[] {
  const rows = getDb()
    .prepare(
      `UPDATE alerts SET cleared_at = @clearedAt
       WHERE source_alert_id = @sourceAlertId AND cleared_at IS NULL
       RETURNING session_id AS sessionId`,
    )
    .all({ sourceAlertId, clearedAt }) as Array<{ sessionId: string | null }>;
  // A queued row has no session to publish against. One session can also cover
  // the same alert twice; the caller wants sessions.
  return [
    ...new Set(
      rows.map((r) => r.sessionId).filter((id): id is string => id !== null),
    ),
  ];
}

/* Already investigated, and nothing has said the condition recovered. Scoped to
   uncleared rows rather than to live runs: Alertmanager repeats a firing alert
   on `repeat_interval`, so a narrower rule opens a fresh investigation of the
   same alert every few minutes once the first one has finished. */
export function isAlertCovered(
  sourceAlertId: string,
  firedAt: string,
): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM alerts
       WHERE source_alert_id = ? AND fired_at = ? AND cleared_at IS NULL
       LIMIT 1`,
    )
    .get(sourceAlertId, firedAt);
  return row !== undefined;
}

/* The session an arriving alert joins, or undefined. Alertmanager grouped these
   together under the user's own `group_by`, so this is their decision arriving as
   data - never a relationship we inferred from labels or from the fleet. */
export function sessionCoveringGroup(groupKey: string): string | undefined {
  const row = getDb()
    .prepare(
      `SELECT a.session_id AS sessionId
       FROM alerts a
       JOIN sessions s ON s.session_id = a.session_id
       WHERE a.group_key = ? AND s.run_state IN ('running', 'suspended')
       LIMIT 1`,
    )
    .get(groupKey) as { sessionId: string } | undefined;
  return row?.sessionId;
}

// One group of alerts waiting for a seat, ready to become a session.
export interface QueuedGroup {
  groupKey: string;
  alerts: NormalizedAlert[];
}

function parseAlert(raw: string): NormalizedAlert[] {
  try {
    return [JSON.parse(raw) as NormalizedAlert];
  } catch {
    return [];
  }
}

const QUEUED = `session_id IS NULL AND cleared_at IS NULL`;

/* The next group to investigate, by arrival. Cleared rows are skipped rather
   than promoted: an alert that recovered while it waited needs no investigation,
   and opening one to report on a condition that is already over is worse than
   silence. */
export function oldestQueuedGroup(): QueuedGroup | undefined {
  const db = getDb();
  const head = db
    .prepare(
      `SELECT group_key AS groupKey FROM alerts
       WHERE ${QUEUED} ORDER BY arrived_at ASC, id ASC LIMIT 1`,
    )
    .get() as { groupKey: string } | undefined;
  if (head === undefined) return undefined;

  const rows = db
    .prepare(
      `SELECT alert FROM alerts
       WHERE group_key = ? AND ${QUEUED} ORDER BY id ASC`,
    )
    .all(head.groupKey) as Array<{ alert: string }>;
  const alerts = rows.flatMap((r) => parseAlert(r.alert));
  return alerts.length === 0 ? undefined : { groupKey: head.groupKey, alerts };
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

// What the console's queue band reports: how many alerts are waiting, and how
// long the one at the front has been waiting.
export function queueDepth(): {
  waiting: number;
  oldestArrivedAt: string | null;
} {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS waiting, MIN(arrived_at) AS oldestArrivedAt
       FROM alerts WHERE ${QUEUED}`,
    )
    .get() as { waiting: number; oldestArrivedAt: string | null };
  return row;
}

// Overwrites unconditionally: the refined title deliberately replaces the
// temporary first-message title once the run has generated it.
export function updateSessionTitle(sessionId: string, title: string): void {
  getDb()
    .prepare(`UPDATE sessions SET title = ? WHERE session_id = ?`)
    .run(title, sessionId);
}

interface AlertRow {
  sessionId: string;
  arrivedAt: string;
  clearedAt: string | null;
  injected: number;
  droppedAlerts: number;
  alert: string;
}

// Untrusted on read for the same reason as the canonical column below: a session
// holding one unreadable alert should still open, showing the rest.
function toSessionAlert(row: AlertRow): SessionAlert[] {
  try {
    return [
      {
        alert: JSON.parse(row.alert) as NormalizedAlert,
        arrivedAt: row.arrivedAt,
        clearedAt: row.clearedAt,
        injected: row.injected === 1,
        droppedAlerts: row.droppedAlerts,
      },
    ];
  } catch {
    return [];
  }
}

const ALERT_COLUMNS = `session_id AS sessionId, arrived_at AS arrivedAt,
        cleared_at AS clearedAt, injected, dropped_alerts AS droppedAlerts, alert`;

// id ascending is arrival order, which is what the first alert of a batch means
// to everything that reads one.
function alertsFor(sessionId: string): SessionAlert[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ALERT_COLUMNS} FROM alerts
       WHERE session_id = ? ORDER BY id ASC`,
    )
    .all(sessionId) as AlertRow[];
  return rows.flatMap(toSessionAlert);
}

// One query for a whole page of sessions, rather than a correlated subquery per
// row: the page is bounded, so this is two statements however long the list is.
function alertsForMany(sessionIds: string[]): Map<string, SessionAlert[]> {
  const byId = new Map<string, SessionAlert[]>();
  if (sessionIds.length === 0) return byId;
  const holes = sessionIds.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT ${ALERT_COLUMNS} FROM alerts
       WHERE session_id IN (${holes}) ORDER BY id ASC`,
    )
    .all(...sessionIds) as AlertRow[];
  for (const row of rows) {
    const entries = byId.get(row.sessionId) ?? [];
    entries.push(...toSessionAlert(row));
    byId.set(row.sessionId, entries);
  }
  return byId;
}

function serializeCanonical(m: TranscriptRow): string | null {
  if (m.parts.length === 0 && m.native === undefined) return null;
  return JSON.stringify({ parts: m.parts, native: m.native });
}

// Untrusted on read despite being our own INSERT: a partial write or a schema change
// should surface as an empty turn, never crash the transcript or a resume.
function parseCanonical(raw: string | null): {
  parts: MessagePart[];
  native?: NativeEnvelope;
} {
  if (raw === null) return { parts: [] };
  try {
    const parsed = JSON.parse(raw) as {
      parts?: MessagePart[];
      native?: NativeEnvelope;
    };
    return {
      parts: Array.isArray(parsed.parts) ? parsed.parts : [],
      ...(parsed.native && { native: parsed.native }),
    };
  } catch {
    return { parts: [] };
  }
}

// The newest row's timestamp, kept on the session because the queue sorts on it.
// Written inside each appender's transaction, so it cannot fall behind the
// transcript it summarises.
function touchSession(sessionId: string, at: string): void {
  getDb()
    .prepare(
      `UPDATE sessions SET last_activity_at = @at WHERE session_id = @sessionId`,
    )
    .run({ sessionId, at });
}

// Append a turn's rows atomically: the (session_id, seq) primary key forbids a
// duplicate seq, and the transaction makes the turn all-or-nothing so the
// transcript checkpoint never holds a hole.
export function appendTranscriptRows(messages: TranscriptRow[]): void {
  if (messages.length === 0) return;
  const insert = getDb().prepare(
    `INSERT INTO session_transcript
       (session_id, seq, kind, content, canonical, timestamp)
     VALUES (@sessionId, @seq, @kind, @content, @canonical, @timestamp)`,
  );
  const insertAll = getDb().transaction((rows: TranscriptRow[]) => {
    for (const m of rows) {
      insert.run({
        sessionId: m.sessionId,
        seq: m.seq,
        kind: m.kind,
        content: m.content,
        canonical: serializeCanonical(m),
        timestamp: m.timestamp,
      });
    }
    const last = rows[rows.length - 1];
    if (last) touchSession(last.sessionId, last.timestamp);
  });
  insertAll(messages);
}

export function getNextSeq(sessionId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(MAX(seq), -1) + 1 AS next
       FROM session_transcript WHERE session_id = ?`,
    )
    .get(sessionId) as { next: number };
  return row.next;
}

// NightWarden's own failure note, appended after the turn that died. Display
// and history only; buildSeed keeps it away from the model.
export function appendErrorMessage(
  sessionId: string,
  text: string,
): TranscriptRow {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO session_transcript
       (session_id, seq, kind, content, canonical, timestamp)
     VALUES (@sessionId, @seq, 'error', @content, NULL, @timestamp)`,
  );
  const message: TranscriptRow = {
    sessionId,
    seq: 0,
    kind: "error",
    content: text,
    parts: [],
    timestamp: new Date().toISOString(),
  };
  db.transaction(() => {
    message.seq = getNextSeq(sessionId);
    insert.run({
      sessionId,
      seq: message.seq,
      content: text,
      timestamp: message.timestamp,
    });
    touchSession(sessionId, message.timestamp);
  })();
  return message;
}

// Called when suspending on a gated tool, so the DB is always consistent:
// both the messages and interrupt row exist, or neither does.
export function appendRowsAndInterrupt(
  messages: TranscriptRow[],
  pendingHumanInput: PendingHumanInput,
): void {
  const insertMsg = getDb().prepare(
    `INSERT INTO session_transcript
       (session_id, seq, kind, content, canonical, timestamp)
     VALUES (@sessionId, @seq, @kind, @content, @canonical, @timestamp)`,
  );
  const insertHumanInput = getDb().prepare(
    `INSERT INTO pending_human_input
       (session_id, tool_use_id, kind, completed_results, claimed_at)
     VALUES (@sessionId, @toolUseId, @kind, @completedResults, @claimedAt)`,
  );
  // Suspending IS the interrupt row, so the state that keeps this session's seat
  // is written with it rather than by whoever notices afterwards.
  const suspend = getDb().prepare(
    `UPDATE sessions SET run_state = 'suspended' WHERE session_id = ?`,
  );
  const txn = getDb().transaction(() => {
    for (const m of messages) {
      insertMsg.run({
        sessionId: m.sessionId,
        seq: m.seq,
        kind: m.kind,
        content: m.content,
        canonical: serializeCanonical(m),
        timestamp: m.timestamp,
      });
    }
    insertHumanInput.run({
      sessionId: pendingHumanInput.sessionId,
      toolUseId: pendingHumanInput.toolUseId,
      kind: pendingHumanInput.kind,
      completedResults: JSON.stringify(pendingHumanInput.completedResults),
      claimedAt: pendingHumanInput.claimedAt ?? null,
    });
    suspend.run(pendingHumanInput.sessionId);
    const last = messages[messages.length - 1];
    if (last) touchSession(last.sessionId, last.timestamp);
  });
  txn();
}

// Takes the report column with it and cascades to the transcript and the pending
// approval. Nothing about a session outlives it.
export function deleteSession(sessionId: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
}

// Raw material for the sessions queue: one row per session, with its action log
// and the transcript's tail. Deriving a status from all that lives in
// session/list.ts, which also knows the dispatcher.
export interface SessionListSource {
  sessionId: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  alerts: SessionAlert[];
  investigation: boolean;
  report: Report | null;
  lastKind: string | null;
  // The tail's text, which is why a failed run failed when lastKind is "error".
  lastContent: string | null;
  awaitingHumanInput: boolean;
  // What the session is waiting on, null when it waits on nothing.
  pendingKind: PendingHumanInput["kind"] | null;
}

// One page of it. nextOffset is the offset to ask for next, or null once the
// list is exhausted.
interface SessionListSourcePage {
  sources: SessionListSource[];
  nextOffset: number | null;
}

interface SessionListRawRow {
  sessionId: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  investigation: number;
  report: string | null;
  lastKind: string | null;
  lastContent: string | null;
  awaitingHumanInput: number;
  pendingKind: string | null;
}

const LIST_COLUMNS = `s.session_id AS sessionId, s.title, s.created_at AS createdAt,
        s.investigation, s.report,
        (SELECT m.kind FROM session_transcript m
          WHERE m.session_id = s.session_id
          ORDER BY m.seq DESC LIMIT 1) AS lastKind,
        (SELECT m.content FROM session_transcript m
          WHERE m.session_id = s.session_id
          ORDER BY m.seq DESC LIMIT 1) AS lastContent,
        s.last_activity_at AS lastActivityAt,
        (p.session_id IS NOT NULL) AS awaitingHumanInput,
        p.kind AS pendingKind`;

function toSource(
  r: SessionListRawRow,
  alerts: SessionAlert[],
): SessionListSource {
  return {
    sessionId: r.sessionId,
    title: r.title,
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
    alerts,
    investigation: r.investigation === 1,
    report: r.report !== null ? (JSON.parse(r.report) as Report) : null,
    lastKind: r.lastKind,
    lastContent: r.lastContent,
    awaitingHumanInput: r.awaitingHumanInput === 1,
    pendingKind:
      r.pendingKind !== null && isHumanInputKind(r.pendingKind)
        ? r.pendingKind
        : null,
  };
}

// Ordering is the store's, not the console's: a waiting session leads the whole
// list, and the id tiebreak stops a row swapping pages between fetches.
export function listSessionSources(
  limit: number,
  offset: number,
  kind?: SessionKind,
): SessionListSourcePage {
  const filter =
    kind === undefined
      ? ""
      : `WHERE s.investigation = ${kind === "investigation" ? 1 : 0}`;
  const rows = getDb()
    .prepare(
      `SELECT ${LIST_COLUMNS}
       FROM sessions s
       LEFT JOIN pending_human_input p ON p.session_id = s.session_id
       ${filter}
       ORDER BY awaitingHumanInput DESC, lastActivityAt DESC, s.session_id ASC
       LIMIT ? OFFSET ?`,
    )
    // One extra row answers "is there a next page?" without a second count query.
    .all(limit + 1, offset) as SessionListRawRow[];
  const page = rows.slice(0, limit);
  const alerts = alertsForMany(page.map((r) => r.sessionId));
  return {
    sources: page.map((r) => toSource(r, alerts.get(r.sessionId) ?? [])),
    nextOffset: rows.length > limit ? offset + page.length : null,
  };
}

// The queue's total is a claim about the whole set, which no page of rows can
// answer. It is a count, so it is counted: loading every investigation and its
// report to take the length of the array is the same answer at any size.
export function countInvestigations(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS total FROM sessions WHERE investigation = 1`)
    .get() as { total: number };
  return row.total;
}

/* Claims the run slot, answering whether this caller got it. The conditional
   UPDATE is the whole mutex: two racing dispatches both attempt it, one changes
   a row and one does not, so a second run cannot start behind a stale check.

   Claimable from 'suspended' as well as 'done', because answering an approval is
   exactly a suspended session starting a run again - and it is not taking a new
   seat, it already held one while it waited. Only 'running' refuses. */
export function claimRun(sessionId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE sessions SET run_state = 'running'
       WHERE session_id = ? AND run_state IN ('done', 'suspended')`,
    )
    .run(sessionId);
  return result.changes > 0;
}

/* Released on every exit path a run has, including the ones that failed.
   Conditional on 'running' so it cannot undo the 'suspended' the loop wrote in
   the same transaction as the interrupt row: that session is waiting, not idle,
   and it keeps its seat while it waits. */
export function releaseRun(sessionId: string): void {
  getDb()
    .prepare(
      `UPDATE sessions SET run_state = 'done'
       WHERE session_id = ? AND run_state = 'running'`,
    )
    .run(sessionId);
}

/* Why the last run failed and how many times we have tried. Recorded at the
   failure, because `describeLLMError`'s prose cannot be classified afterwards -
   and the whole point is to never retry a bad key or an empty account. */
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

/* Seats in use. An investigation holds one while suspended because the human it
   is waiting on is the scarce thing: freeing the seat starts another run whose
   write needs that same person. A chat holds one only while it is actually
   working - it was started by someone sitting right there. */
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

// Sessions still holding a condition nobody has seen recover. What the
// reconciler works through, and the only reason it wakes up. Queued alerts are
// excluded: nothing has investigated them, so there is no recovery to verify.
export function sessionIdsWithOpenAlerts(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT session_id AS sessionId FROM alerts
       WHERE cleared_at IS NULL AND session_id IS NOT NULL
       ORDER BY session_id`,
    )
    .all() as Array<{ sessionId: string }>;
  return rows.map((r) => r.sessionId);
}

/* Sessions holding a seat while parked on a human. Read at boot to find the ones
   parked on nobody: approving deletes the interrupt row before the resume claims
   the run, so a crash in that gap leaves a session suspended with nothing left to
   answer it - and, now that suspending holds a seat, holding one forever. */
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
              created_at AS createdAt
       FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as (SessionMeta & { investigation: number }) | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.sessionId,
    title: row.title,
    createdAt: row.createdAt,
    investigation: row.investigation === 1,
    alerts: alertsFor(sessionId),
  };
}

export function getTranscriptRows(sessionId: string): TranscriptRow[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id AS sessionId, seq, kind, content,
              canonical, timestamp
       FROM session_transcript WHERE session_id = ? ORDER BY seq ASC`,
    )
    .all(sessionId) as Array<{
    sessionId: string;
    seq: number;
    kind: string;
    content: string;
    canonical: string | null;
    timestamp: string;
  }>;
  return rows.map((r) => ({
    sessionId: r.sessionId,
    // kind is constrained to TranscriptKind on write; the column is plain TEXT.
    kind: r.kind as TranscriptRow["kind"],
    seq: r.seq,
    content: r.content,
    ...parseCanonical(r.canonical),
    timestamp: r.timestamp,
  }));
}

// What a tool call was, read from the transcript that recorded it. Null for a
// synthetic id, which is what a continue request carries: it gates on no tool.
export function findToolCall(
  sessionId: string,
  toolUseId: string,
): { name: string; input: Record<string, unknown> } | null {
  for (const row of getTranscriptRows(sessionId)) {
    for (const part of row.parts) {
      if (part.type === "tool_call" && part.id === toolUseId) {
        return { name: part.name, input: part.input };
      }
    }
  }
  return null;
}
