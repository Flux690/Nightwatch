import type { Report, ReportSummary } from "@nightwarden/shared";
import { getDb } from "./client.js";

// Full-replace: every UpdateReport carries the complete document, so a re-run or
// a mid-run revision overwrites the single row atomically.
export function upsertReport(
  sessionId: string,
  report: Report,
  model: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO reports (session_id, report, model, updated_at)
       VALUES (@sessionId, @report, @model, @updatedAt)
       ON CONFLICT(session_id) DO UPDATE SET
         report = @report, model = @model, updated_at = @updatedAt`,
    )
    .run({
      sessionId,
      report: JSON.stringify(report),
      model,
      updatedAt: report.updatedAt,
    });
}

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

// Newest first, capped like the other list readers. Parses each blob down to the
// row fields the Sessions queue needs.
export function listReportSummaries(): ReportSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id AS sessionId, report FROM reports
       ORDER BY updated_at DESC LIMIT 200`,
    )
    .all() as Array<{ sessionId: string; report: string }>;
  return rows.map((r) => {
    const report = JSON.parse(r.report) as Report;
    return {
      sessionId: r.sessionId,
      status: report.status,
      headline: report.headline,
      rootCauseSummary: report.rootCause.summary,
    };
  });
}

// The gate predicate as a pure function so it is unit-testable in isolation.
// investigation_incomplete is the non-terminal state the exit gate rejects;
// inconclusive is a legal honest terminal; root_cause_identified must be fully
// resolved and evidence-backed.
export function isReportComplete(report: Report): boolean {
  if (report.status === "investigation_incomplete") return false;
  if (report.status === "inconclusive") return true;
  if (!report.rootCause.summary.trim()) return false;
  if (report.hypotheses.some((h) => h.state === "open")) return false;
  const rootCauses = report.hypotheses.filter((h) => h.state === "root_cause");
  return (
    rootCauses.length > 0 && rootCauses.some((h) => h.evidenceIds.length > 0)
  );
}

export function reportComplete(sessionId: string): boolean {
  const report = getReport(sessionId);
  return report !== undefined && isReportComplete(report);
}
