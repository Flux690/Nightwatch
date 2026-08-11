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

const INSERT_ALERT = `INSERT INTO session_alerts
     (session_id, source_alert_id, fired_at, arrived_at, cleared_at, alert)
   VALUES (@sessionId, @sourceAlertId, @firedAt, @arrivedAt, NULL, @alert)`;

function alertParams(
  sessionId: string,
  alert: NormalizedAlert,
  arrivedAt: string,
): Record<string, string> {
  return {
    sessionId,
    sourceAlertId: alert.sourceAlertId,
    firedAt: alert.firedAt,
    arrivedAt,
    alert: JSON.stringify(alert),
  };
}

// Create the session row once, with the alerts that opened it. Idempotent: a
// resume re-enters the loop with the same id, and the first title/alerts win -
// later runs never clobber them.
export function createSession(
  meta: SessionMeta,
  alerts: NormalizedAlert[],
  investigation = false,
): void {
  const db = getDb();
  const insertSession = db.prepare(
    `INSERT INTO sessions (session_id, title, investigation, created_at)
     VALUES (@sessionId, @title, @investigation, @createdAt)
     ON CONFLICT(session_id) DO NOTHING`,
  );
  const insertAlert = db.prepare(INSERT_ALERT);
  db.transaction((): void => {
    const created = insertSession.run({
      sessionId: meta.sessionId,
      title: meta.title,
      investigation: investigation ? 1 : 0,
      createdAt: meta.createdAt,
    });
    // Only the call that created the row writes the batch, so a resume cannot
    // append a second copy of the alerts the session already covers.
    if (created.changes === 0) return;
    for (const alert of alerts) {
      insertAlert.run(alertParams(meta.sessionId, alert, meta.createdAt));
    }
  })();
}

// An alert that arrived while the run was already working. `arrivedAt` is what
// later places it in the transcript, at the turn it interrupted.
export function appendSessionAlert(
  sessionId: string,
  alert: NormalizedAlert,
): void {
  getDb()
    .prepare(INSERT_ALERT)
    .run(alertParams(sessionId, alert, new Date().toISOString()));
}

// Releases alerts a run never got to, so the session that picks them up is the
// only one covering them. Left here they would name alerts this run never saw,
// and hold the session open until every one of them cleared.
export function dropSessionAlerts(
  sessionId: string,
  alerts: NormalizedAlert[],
): void {
  if (alerts.length === 0) return;
  const db = getDb();
  const remove = db.prepare(
    `DELETE FROM session_alerts
     WHERE session_id = @sessionId
       AND source_alert_id = @sourceAlertId AND fired_at = @firedAt`,
  );
  db.transaction((): void => {
    for (const alert of alerts) {
      remove.run({
        sessionId,
        sourceAlertId: alert.sourceAlertId,
        firedAt: alert.firedAt,
      });
    }
  })();
}

// Stamps this alert wherever it is still open. The first clear wins per alert: a
// re-fire that clears again says nothing new about that condition. Returns the
// sessions it touched, which is not the same as the sessions now resolved.
export function markAlertCleared(
  sourceAlertId: string,
  clearedAt: string,
): string[] {
  const rows = getDb()
    .prepare(
      `UPDATE session_alerts SET cleared_at = @clearedAt
       WHERE source_alert_id = @sourceAlertId AND cleared_at IS NULL
       RETURNING session_id AS sessionId`,
    )
    .all({ sourceAlertId, clearedAt }) as Array<{ sessionId: string }>;
  // One session can cover the same alert twice; the caller wants sessions.
  return [...new Set(rows.map((r) => r.sessionId))];
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
      },
    ];
  } catch {
    return [];
  }
}

const ALERT_COLUMNS = `session_id AS sessionId, arrived_at AS arrivedAt,
        cleared_at AS clearedAt, alert`;

// id ascending is arrival order, which is what the first alert of a batch means
// to everything that reads one.
function alertsFor(sessionId: string): SessionAlert[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ALERT_COLUMNS} FROM session_alerts
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
      `SELECT ${ALERT_COLUMNS} FROM session_alerts
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
        COALESCE((SELECT MAX(m.timestamp) FROM session_transcript m
          WHERE m.session_id = s.session_id), s.created_at) AS lastActivityAt,
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

// Every investigation, unpaginated: the counts on the page are claims about the
// whole set, which no page of rows can answer.
export function listInvestigationSources(): SessionListSource[] {
  const rows = getDb()
    .prepare(
      `SELECT ${LIST_COLUMNS}
       FROM sessions s
       LEFT JOIN pending_human_input p ON p.session_id = s.session_id
       WHERE s.investigation = 1`,
    )
    .all() as SessionListRawRow[];
  const alerts = alertsForMany(rows.map((r) => r.sessionId));
  return rows.map((r) => toSource(r, alerts.get(r.sessionId) ?? []));
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
