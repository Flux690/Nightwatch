import Database from "better-sqlite3";
import type {
  IncidentRecord,
  SessionMessage,
  SessionMeta,
} from "@nightwatch/shared";

const DB_PATH =
  process.env["NIGHTWATCH_DB_PATH"] ?? "/var/nightwatch/history.db";

let _db: Database.Database | undefined;

function db(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        incidentId          TEXT PRIMARY KEY,
        timestamp           TEXT NOT NULL,
        containerName       TEXT NOT NULL,
        alertType           TEXT NOT NULL,
        rootCause           TEXT NOT NULL DEFAULT '',
        resolutionAction    TEXT,
        resolvedAt          TEXT,
        humanResolutionNote TEXT,
        recurrenceCount     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id  TEXT PRIMARY KEY,
        token       TEXT NOT NULL,
        trigger     TEXT NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id       TEXT NOT NULL REFERENCES sessions(session_id),
        seq              INTEGER NOT NULL,
        role             TEXT NOT NULL,
        content          TEXT NOT NULL,
        provider_content TEXT,
        created_at       TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_messages_session
        ON session_messages(session_id, seq);
    `);
  }
  return _db;
}

export function initDb(): void {
  db();
}

export function insertIncident(record: IncidentRecord): void {
  db()
    .prepare(
      `INSERT OR REPLACE INTO incidents
       (incidentId, timestamp, containerName, alertType, rootCause,
        resolutionAction, resolvedAt, humanResolutionNote, recurrenceCount)
       VALUES (@incidentId, @timestamp, @containerName, @alertType, @rootCause,
               @resolutionAction, @resolvedAt, @humanResolutionNote, @recurrenceCount)`,
    )
    .run({
      incidentId: record.incidentId,
      timestamp: record.timestamp,
      containerName: record.containerName,
      alertType: record.alertType,
      rootCause: record.rootCause,
      resolutionAction: record.resolutionAction ?? null,
      resolvedAt: record.resolvedAt ?? null,
      humanResolutionNote: record.humanResolutionNote ?? null,
      recurrenceCount: record.recurrenceCount,
    });
}

export function getRecentIncidents(
  containerName?: string,
  alertType?: string,
  limitDays = 30,
): IncidentRecord[] {
  const since = new Date(Date.now() - limitDays * 86_400_000).toISOString();
  const conditions = ["timestamp >= ?"];
  const params: string[] = [since];
  if (containerName) {
    conditions.push("containerName = ?");
    params.push(containerName);
  }
  if (alertType) {
    conditions.push("alertType = ?");
    params.push(alertType);
  }
  const rows = db()
    .prepare(
      `SELECT * FROM incidents
       WHERE ${conditions.join(" AND ")}
       ORDER BY timestamp DESC LIMIT 50`,
    )
    .all(...params);
  return rows as IncidentRecord[];
}

export function getIncidentById(
  incidentId: string,
): IncidentRecord | undefined {
  return db()
    .prepare(`SELECT * FROM incidents WHERE incidentId = ?`)
    .get(incidentId) as IncidentRecord | undefined;
}

export function updateResolutionNote(incidentId: string, note: string): void {
  db()
    .prepare(
      `UPDATE incidents SET humanResolutionNote = ? WHERE incidentId = ?`,
    )
    .run(note, incidentId);
}

// Idempotent: the API sends session meta on every append so the first turn of a
// session creates the row and later turns are no-ops (title may be refined).
export function upsertSession(meta: SessionMeta): void {
  db()
    .prepare(
      `INSERT INTO sessions (session_id, token, trigger, title, created_at)
       VALUES (@sessionId, @token, @trigger, @title, @createdAt)
       ON CONFLICT(session_id) DO UPDATE SET title = excluded.title`,
    )
    .run(meta);
}

export function appendSessionMessage(message: SessionMessage): void {
  db()
    .prepare(
      `INSERT INTO session_messages
       (session_id, seq, role, content, provider_content, created_at)
       VALUES (@sessionId, @seq, @role, @content, @providerContent, @createdAt)`,
    )
    .run({
      sessionId: message.sessionId,
      seq: message.seq,
      role: message.role,
      content: message.content,
      // Provider-native blocks are stored as JSON text; null when absent.
      providerContent:
        message.providerContent != null
          ? JSON.stringify(message.providerContent)
          : null,
      createdAt: message.createdAt,
    });
}

export function getSessions(token: string): SessionMeta[] {
  const rows = db()
    .prepare(
      `SELECT session_id AS sessionId, token, trigger, title, created_at AS createdAt
       FROM sessions WHERE token = ? ORDER BY created_at DESC LIMIT 100`,
    )
    .all(token);
  return rows as SessionMeta[];
}

export function getSessionMessages(sessionId: string): SessionMessage[] {
  const rows = db()
    .prepare(
      `SELECT session_id AS sessionId, seq, role, content,
              provider_content AS providerContent, created_at AS createdAt
       FROM session_messages WHERE session_id = ? ORDER BY seq ASC`,
    )
    .all(sessionId) as Array<{
    sessionId: string;
    seq: number;
    role: string;
    content: string;
    providerContent: string | null;
    createdAt: string;
  }>;
  return rows.map((r) => ({
    sessionId: r.sessionId,
    // role is constrained to SessionRole on write; the column is plain TEXT.
    role: r.role as SessionMessage["role"],
    seq: r.seq,
    content: r.content,
    providerContent:
      r.providerContent != null ? JSON.parse(r.providerContent) : undefined,
    createdAt: r.createdAt,
  }));
}
