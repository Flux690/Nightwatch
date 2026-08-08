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
export type StoredSession = SessionMeta & {
  alerts: SessionAlert[];
  investigation: boolean;
};

function joining(alerts: NormalizedAlert[], at: string): SessionAlert[] {
  return alerts.map((alert) => ({ alert, arrivedAt: at, clearedAt: null }));
}

// Create the session row once. Idempotent: a resume re-enters the loop with the
// same id, and the first title/alerts win - later runs never clobber them.
export function createSession(
  meta: SessionMeta,
  alerts: NormalizedAlert[],
  investigation = false,
): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (session_id, title, alerts, investigation, created_at)
       VALUES (@sessionId, @title, @alerts, @investigation, @createdAt)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .run({
      sessionId: meta.sessionId,
      title: meta.title,
      alerts: JSON.stringify(joining(alerts, meta.createdAt)),
      investigation: investigation ? 1 : 0,
      createdAt: meta.createdAt,
    });
}

function writeAlerts(sessionId: string, alerts: SessionAlert[]): void {
  getDb()
    .prepare(`UPDATE sessions SET alerts = @alerts WHERE session_id = @id`)
    .run({ id: sessionId, alerts: JSON.stringify(alerts) });
}

// An alert that arrived while the run was already working. Read-modify-write in
// a transaction so two arriving at once cannot lose each other. `arrivedAt` is
// what later places it in the transcript, at the turn it interrupted.
export function appendSessionAlert(
  sessionId: string,
  alert: NormalizedAlert,
): void {
  getDb().transaction((): void => {
    const alerts = getSession(sessionId)?.alerts ?? [];
    writeAlerts(sessionId, [
      ...alerts,
      { alert, arrivedAt: new Date().toISOString(), clearedAt: null },
    ]);
  })();
}

// Stamps this alert wherever it appears. The first clear wins per alert: a
// re-fire that clears again says nothing new about that condition. Returns the
// sessions it touched, which is not the same as the sessions now resolved.
export function markAlertCleared(
  sourceAlertId: string,
  clearedAt: string,
): string[] {
  return getDb().transaction((): string[] => {
    const rows = getDb()
      .prepare(
        `SELECT session_id AS sessionId, alerts FROM sessions
         WHERE EXISTS (SELECT 1 FROM json_each(alerts)
                       WHERE json_extract(value, '$.alert.sourceAlertId') = @sourceAlertId
                         AND json_extract(value, '$.clearedAt') IS NULL)`,
      )
      .all({ sourceAlertId }) as Array<{ sessionId: string; alerts: string }>;
    for (const row of rows) {
      writeAlerts(
        row.sessionId,
        parseAlerts(row.alerts).map((entry) =>
          entry.alert.sourceAlertId === sourceAlertId &&
          entry.clearedAt === null
            ? { ...entry, clearedAt }
            : entry,
        ),
      );
    }
    return rows.map((r) => r.sessionId);
  })();
}

// Overwrites unconditionally: the refined title deliberately replaces the
// temporary first-message title once the run has generated it.
export function updateSessionTitle(sessionId: string, title: string): void {
  getDb()
    .prepare(`UPDATE sessions SET title = ? WHERE session_id = ?`)
    .run(title, sessionId);
}

// Untrusted on read for the same reason as the canonical column below: a session
// with an unreadable alert list should still open, showing no alerts.
function parseAlerts(raw: string): SessionAlert[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SessionAlert[]) : [];
  } catch {
    return [];
  }
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
       (session_id, seq, kind, content, canonical, created_at)
     VALUES (@sessionId, @seq, @kind, @content, @canonical, @createdAt)`,
  );
  const insertAll = getDb().transaction((rows: TranscriptRow[]) => {
    for (const m of rows) {
      insert.run({
        sessionId: m.sessionId,
        seq: m.seq,
        kind: m.kind,
        content: m.content,
        canonical: serializeCanonical(m),
        createdAt: m.createdAt,
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
       (session_id, seq, kind, content, canonical, created_at)
     VALUES (@sessionId, @seq, 'error', @content, NULL, @createdAt)`,
  );
  const message: TranscriptRow = {
    sessionId,
    seq: 0,
    kind: "error",
    content: text,
    parts: [],
    createdAt: new Date().toISOString(),
  };
  db.transaction(() => {
    message.seq = getNextSeq(sessionId);
    insert.run({
      sessionId,
      seq: message.seq,
      content: text,
      createdAt: message.createdAt,
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
       (session_id, seq, kind, content, canonical, created_at)
     VALUES (@sessionId, @seq, @kind, @content, @canonical, @createdAt)`,
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
        createdAt: m.createdAt,
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
// approval. The remediation audit log is not a child of sessions, so it survives.
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
  remediationExecuted: boolean;
  lastKind: string | null;
  // The tail's text, which is why a failed run failed when lastKind is "error".
  lastContent: string | null;
  awaitingHumanInput: boolean;
  // What the session is waiting on, null when it waits on nothing.
  pendingKind: PendingHumanInput["kind"] | null;
}

// One page of it. nextOffset is the offset to ask for next, or null once the
// list is exhausted.
export interface SessionListSourcePage {
  sources: SessionListSource[];
  nextOffset: number | null;
}

interface SessionListRawRow {
  sessionId: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  alerts: string;
  investigation: number;
  report: string | null;
  remediationExecuted: number;
  lastKind: string | null;
  lastContent: string | null;
  awaitingHumanInput: number;
  pendingKind: string | null;
}

const LIST_COLUMNS = `s.session_id AS sessionId, s.title, s.created_at AS createdAt,
        s.alerts, s.investigation, s.report,
        EXISTS (SELECT 1 FROM remediation_actions ra
          WHERE ra.session_id = s.session_id
            AND ra.status = 'executed') AS remediationExecuted,
        (SELECT m.kind FROM session_transcript m
          WHERE m.session_id = s.session_id
          ORDER BY m.seq DESC LIMIT 1) AS lastKind,
        (SELECT m.content FROM session_transcript m
          WHERE m.session_id = s.session_id
          ORDER BY m.seq DESC LIMIT 1) AS lastContent,
        COALESCE((SELECT MAX(m.created_at) FROM session_transcript m
          WHERE m.session_id = s.session_id), s.created_at) AS lastActivityAt,
        (p.session_id IS NOT NULL) AS awaitingHumanInput,
        p.kind AS pendingKind`;

function toSource(r: SessionListRawRow): SessionListSource {
  return {
    sessionId: r.sessionId,
    title: r.title,
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
    alerts: parseAlerts(r.alerts),
    investigation: r.investigation === 1,
    report: r.report !== null ? (JSON.parse(r.report) as Report) : null,
    remediationExecuted: r.remediationExecuted === 1,
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
  return {
    sources: page.map(toSource),
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
  return rows.map(toSource);
}

export function getSession(sessionId: string): StoredSession | undefined {
  const row = getDb()
    .prepare(
      `SELECT session_id AS sessionId, title, investigation,
              alerts, created_at AS createdAt
       FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as
    (SessionMeta & { alerts: string; investigation: number }) | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.sessionId,
    title: row.title,
    createdAt: row.createdAt,
    investigation: row.investigation === 1,
    alerts: parseAlerts(row.alerts),
  };
}

export function getTranscriptRows(sessionId: string): TranscriptRow[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id AS sessionId, seq, kind, content,
              canonical, created_at AS createdAt
       FROM session_transcript WHERE session_id = ? ORDER BY seq ASC`,
    )
    .all(sessionId) as Array<{
    sessionId: string;
    seq: number;
    kind: string;
    content: string;
    canonical: string | null;
    createdAt: string;
  }>;
  return rows.map((r) => ({
    sessionId: r.sessionId,
    // kind is constrained to TranscriptKind on write; the column is plain TEXT.
    kind: r.kind as TranscriptRow["kind"],
    seq: r.seq,
    content: r.content,
    ...parseCanonical(r.canonical),
    createdAt: r.createdAt,
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
