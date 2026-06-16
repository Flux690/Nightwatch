import type { IncidentRecord } from "@nightwatch/shared";
import { getDb } from "./client.js";

// Every read aliases these columns into IncidentRecord shape, so the untyped
// better-sqlite3 rows line up and the `as IncidentRecord` casts are sound.
const SELECT_COLS = `id AS incidentId, session_id AS sessionId, outcome, timestamp,
  container_name AS containerName, alert_type AS alertType, root_cause AS rootCause,
  resolution_action AS resolutionAction, resolved_at AS resolvedAt,
  human_resolution_note AS humanResolutionNote, recurrence_count AS recurrenceCount`;

export function insertIncident(record: IncidentRecord): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO incidents
       (id, session_id, outcome, timestamp, container_name, alert_type,
        root_cause, resolution_action, resolved_at, human_resolution_note, recurrence_count)
       VALUES (@id, @sessionId, @outcome, @timestamp, @containerName, @alertType,
               @rootCause, @resolutionAction, @resolvedAt, @humanResolutionNote, @recurrenceCount)`,
    )
    .run({
      id: record.incidentId,
      sessionId: record.sessionId,
      outcome: record.outcome,
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
    conditions.push("container_name = ?");
    params.push(containerName);
  }
  if (alertType) {
    conditions.push("alert_type = ?");
    params.push(alertType);
  }
  // Cast is sound: SELECT_COLS aliases the rows to IncidentRecord (see above).
  return getDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM incidents
       WHERE ${conditions.join(" AND ")}
       ORDER BY timestamp DESC LIMIT 50`,
    )
    .all(...params) as IncidentRecord[];
}

export function getIncidentById(
  incidentId: string,
): IncidentRecord | undefined {
  // Cast is sound: SELECT_COLS aliases the row to IncidentRecord (see above).
  return getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM incidents WHERE id = ?`)
    .get(incidentId) as IncidentRecord | undefined;
}

export function updateResolutionNote(incidentId: string, note: string): void {
  getDb()
    .prepare(`UPDATE incidents SET human_resolution_note = ? WHERE id = ?`)
    .run(note, incidentId);
}
