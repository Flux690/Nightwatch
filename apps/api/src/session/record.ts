import type { Hypothesis, InvestigationRecord } from "@nightwarden/shared";
import { getDb } from "../db.js";

// The record's persistence seam. Three columns on the session: born with it,
// deleted with it, and only ever read alongside it.

export interface RecordRow {
  hypotheses: string;
  report: string | null;
  updatedAt: string | null;
}

const RECORD_COLUMNS = `hypotheses, report, record_updated_at AS updatedAt`;

/* The one place the two columns become a record, so the session list's own
   query assembles it the same way this does. A session that recorded nothing
   reads as absent rather than as an empty record nobody can tell apart. */
export function assembleRecord(
  row: RecordRow | undefined,
): InvestigationRecord | undefined {
  if (row === undefined) return undefined;
  const hypotheses = JSON.parse(row.hypotheses) as Hypothesis[];
  const report =
    row.report === null
      ? null
      : (JSON.parse(row.report) as InvestigationRecord["report"]);
  if (hypotheses.length === 0 && report === null) return undefined;
  return {
    hypotheses,
    report,
    updatedAt: row.updatedAt ?? new Date(0).toISOString(),
  };
}

export function getRecord(sessionId: string): InvestigationRecord | undefined {
  const row = getDb()
    .prepare(`SELECT ${RECORD_COLUMNS} FROM sessions WHERE session_id = ?`)
    .get(sessionId) as RecordRow | undefined;
  return assembleRecord(row);
}

// Whether anything has been written to the record since the given instant. Read
// by the report gate and by the memory extractor, so neither invents its own.
export function recordMovedSince(
  sessionId: string,
  since: string | null,
): boolean {
  const row = getDb()
    .prepare(
      `SELECT record_updated_at AS updatedAt FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as { updatedAt: string | null } | undefined;
  if (row?.updatedAt == null) return false;
  return since === null || row.updatedAt > since;
}

function emptyRecord(): InvestigationRecord {
  return { hypotheses: [], report: null, updatedAt: new Date(0).toISOString() };
}

function write(sessionId: string, record: InvestigationRecord): void {
  getDb()
    .prepare(
      `UPDATE sessions
       SET hypotheses = @hypotheses, report = @report, record_updated_at = @updatedAt
       WHERE session_id = @id`,
    )
    .run({
      id: sessionId,
      hypotheses: JSON.stringify(record.hypotheses),
      report: record.report === null ? null : JSON.stringify(record.report),
      updatedAt: new Date().toISOString(),
    });
}

// One recorded act, read-modify-write in a transaction so two calls in the same
// turn cannot lose each other's write. `value` carries back whatever the caller
// needs to know about the row it just appended.
export function appendHypothesis<T>(
  sessionId: string,
  apply: (record: InvestigationRecord) => {
    next: InvestigationRecord;
    value: T;
  },
): T {
  return getDb().transaction((): T => {
    const { next, value } = apply(getRecord(sessionId) ?? emptyRecord());
    write(sessionId, next);
    return value;
  })();
}

// The same, for an act that may refuse: `apply` returns null to leave the row
// untouched. Returns whether it wrote.
export function amendRecord(
  sessionId: string,
  apply: (record: InvestigationRecord) => InvestigationRecord | null,
): boolean {
  return getDb().transaction((): boolean => {
    const next = apply(getRecord(sessionId) ?? emptyRecord());
    if (next === null) return false;
    write(sessionId, next);
    return true;
  })();
}
