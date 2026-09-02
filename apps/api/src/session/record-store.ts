import type { Hypothesis, InvestigationRecord } from "@nightwarden/shared";
import { getDb, type Db } from "../db.js";

interface RecordRow {
  hypotheses: string;
  report: string | null;
  updatedAt: string | null;
}

// The one place the two columns become a record, so the session list's own
// query assembles it the same way. Nothing recorded reads as absent, not empty.
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

export async function getRecord(
  sessionId: string,
  db: Db = getDb(),
): Promise<InvestigationRecord | undefined> {
  const row = await db
    .selectFrom("sessions")
    .select(["hypotheses", "report", "record_updated_at as updatedAt"])
    .where("session_id", "=", sessionId)
    .executeTakeFirst();
  return assembleRecord(row);
}

function emptyRecord(): InvestigationRecord {
  return { hypotheses: [], report: null, updatedAt: new Date(0).toISOString() };
}

async function write(
  db: Db,
  sessionId: string,
  record: InvestigationRecord,
): Promise<void> {
  await db
    .updateTable("sessions")
    .set({
      hypotheses: JSON.stringify(record.hypotheses),
      report: record.report === null ? null : JSON.stringify(record.report),
      record_updated_at: new Date().toISOString(),
    })
    .where("session_id", "=", sessionId)
    .execute();
}

// Read-modify-write in a transaction, so two calls in the same turn cannot lose
// each other's write.
export function appendHypothesis<T>(
  sessionId: string,
  apply: (record: InvestigationRecord) => {
    next: InvestigationRecord;
    value: T;
  },
): Promise<T> {
  return getDb()
    .transaction()
    .execute(async (trx) => {
      const { next, value } = apply(
        (await getRecord(sessionId, trx)) ?? emptyRecord(),
      );
      await write(trx, sessionId, next);
      return value;
    });
}

// The same, for an act that may refuse: `apply` returns null to leave the row
// untouched. Returns whether it wrote.
export function amendRecord(
  sessionId: string,
  apply: (record: InvestigationRecord) => InvestigationRecord | null,
): Promise<boolean> {
  return getDb()
    .transaction()
    .execute(async (trx) => {
      const next = apply((await getRecord(sessionId, trx)) ?? emptyRecord());
      if (next === null) return false;
      await write(trx, sessionId, next);
      return true;
    });
}
