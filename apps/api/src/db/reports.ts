import type { Report } from "@nightwarden/shared";
import { getDb } from "./client.js";

export function getReport(sessionId: string): Report | undefined {
  const row = getDb()
    .prepare(`SELECT report FROM reports WHERE session_id = ?`)
    .get(sessionId) as { report: string } | undefined;
  return row ? (JSON.parse(row.report) as Report) : undefined;
}

export function hasReport(sessionId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 FROM reports WHERE session_id = ?`)
    .get(sessionId);
  return row !== undefined;
}

function emptyReport(model: string): Report {
  return {
    hypotheses: [],
    fixes: [],
    updatedAt: new Date().toISOString(),
    model,
  };
}

// Attribution rides every write: the row names the model that last touched it.
function writeReport(sessionId: string, report: Report, model: string): void {
  const stamped: Report = {
    ...report,
    updatedAt: new Date().toISOString(),
    model,
  };
  getDb()
    .prepare(
      `INSERT INTO reports (session_id, report, model, updated_at)
       VALUES (@sessionId, @report, @model, @updatedAt)
       ON CONFLICT(session_id) DO UPDATE SET
         report = @report, model = @model, updated_at = @updatedAt`,
    )
    .run({
      sessionId,
      report: JSON.stringify(stamped),
      model,
      updatedAt: stamped.updatedAt,
    });
}

// One recorded act, read-modify-write in a transaction so two calls in the same
// turn cannot lose each other's write. `value` carries back whatever the caller
// needs to know about the row it just appended.
export function appendToReport<T>(
  sessionId: string,
  model: string,
  apply: (report: Report) => { next: Report; value: T },
): T {
  return getDb().transaction((): T => {
    const { next, value } = apply(getReport(sessionId) ?? emptyReport(model));
    writeReport(sessionId, next, model);
    return value;
  })();
}

// The same, for an act that may refuse: `apply` returns null to leave the row
// untouched. Returns whether it wrote.
export function amendReport(
  sessionId: string,
  model: string,
  apply: (report: Report) => Report | null,
): boolean {
  return getDb().transaction((): boolean => {
    const next = apply(getReport(sessionId) ?? emptyReport(model));
    if (next === null) return false;
    writeReport(sessionId, next, model);
    return true;
  })();
}

// The gate predicate as a pure function so it is testable in isolation. A run
// that resolved every hypothesis it proposed has finished, whether or not any
// of them turned out to be the cause; an uncited root cause has not.
export function isReportComplete(report: Report): boolean {
  if (report.hypotheses.length === 0) return false;
  if (report.hypotheses.some((h) => h.verdict === "open")) return false;
  return report.hypotheses
    .filter((h) => h.verdict === "root_cause")
    .every((h) => h.evidenceIds.length > 0);
}

export function reportComplete(sessionId: string): boolean {
  const report = getReport(sessionId);
  return report !== undefined && isReportComplete(report);
}
