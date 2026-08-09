import type { Report } from "@nightwarden/shared";
import { getDb } from "./client.js";

// The record's persistence seam. One report per session, held in a column on it:
// born with the session, deleted with it, and only ever read alongside it.

export function getReport(sessionId: string): Report | undefined {
  const row = getDb()
    .prepare(`SELECT report FROM sessions WHERE session_id = ?`)
    .get(sessionId) as { report: string | null } | undefined;
  return row?.report != null ? (JSON.parse(row.report) as Report) : undefined;
}

export function hasReport(sessionId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM sessions WHERE session_id = ? AND report IS NOT NULL`,
    )
    .get(sessionId);
  return row !== undefined;
}

function emptyReport(): Report {
  return {
    hypotheses: [],
    submitted: null,
    updatedAt: new Date().toISOString(),
  };
}

function writeReport(sessionId: string, report: Report): void {
  const stamped: Report = { ...report, updatedAt: new Date().toISOString() };
  getDb()
    .prepare(`UPDATE sessions SET report = @report WHERE session_id = @id`)
    .run({ id: sessionId, report: JSON.stringify(stamped) });
}

// One recorded act, read-modify-write in a transaction so two calls in the same
// turn cannot lose each other's write. `value` carries back whatever the caller
// needs to know about the row it just appended.
export function appendToReport<T>(
  sessionId: string,
  apply: (report: Report) => { next: Report; value: T },
): T {
  return getDb().transaction((): T => {
    const { next, value } = apply(getReport(sessionId) ?? emptyReport());
    writeReport(sessionId, next);
    return value;
  })();
}

// The same, for an act that may refuse: `apply` returns null to leave the row
// untouched. Returns whether it wrote.
export function amendReport(
  sessionId: string,
  apply: (report: Report) => Report | null,
): boolean {
  return getDb().transaction((): boolean => {
    const next = apply(getReport(sessionId) ?? emptyReport());
    if (next === null) return false;
    writeReport(sessionId, next);
    return true;
  })();
}
