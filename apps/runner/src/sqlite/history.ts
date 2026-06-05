import Database from "better-sqlite3";
import type { IncidentRecord } from "@nightwatch/shared";

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
      )
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
  limitDays = 30,
): IncidentRecord[] {
  const since = new Date(Date.now() - limitDays * 86_400_000).toISOString();
  const rows = containerName
    ? db()
        .prepare(
          `SELECT * FROM incidents
           WHERE containerName = ? AND timestamp >= ?
           ORDER BY timestamp DESC LIMIT 50`,
        )
        .all(containerName, since)
    : db()
        .prepare(
          `SELECT * FROM incidents
           WHERE timestamp >= ?
           ORDER BY timestamp DESC LIMIT 50`,
        )
        .all(since);
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
