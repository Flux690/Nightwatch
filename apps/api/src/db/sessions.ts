import type {
  MessagePart,
  NativeEnvelope,
  NormalizedAlert,
  Report,
  SessionMessage,
  SessionMeta,
} from "@nightwarden/shared";
import { getDb } from "./client.js";
import type { PendingHumanInput } from "./interrupts.js";

// The alert is the durable source of severity-dependent behavior on resume, so
// a run that no longer carries it in its job can recover it from here.
export type StoredSession = SessionMeta & {
  originatingAlert: NormalizedAlert | null;
  investigation: boolean;
};

// Create the session row once. Idempotent: a resume re-enters the loop with the
// same id, and the first title/alert win - later runs never clobber them.
export function createSession(
  meta: SessionMeta,
  originatingAlert: NormalizedAlert | null,
  investigation = false,
): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (session_id, title, originating_alert, investigation, created_at)
       VALUES (@sessionId, @title, @originatingAlert, @investigation, @createdAt)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .run({
      sessionId: meta.sessionId,
      title: meta.title,
      originatingAlert:
        originatingAlert != null ? JSON.stringify(originatingAlert) : null,
      investigation: investigation ? 1 : 0,
      createdAt: meta.createdAt,
    });
}

// One-way: a session put under investigation stays under one for good.
export function openInvestigation(sessionId: string): void {
  getDb()
    .prepare(
      `UPDATE sessions SET investigation = 1 WHERE session_id = ? AND investigation = 0`,
    )
    .run(sessionId);
}

// Read per turn by the loop, so OpenInvestigation takes effect on the next turn
// of the run that called it rather than the next run.
export function isUnderInvestigation(sessionId: string): boolean {
  const row = getDb()
    .prepare(`SELECT investigation FROM sessions WHERE session_id = ?`)
    .get(sessionId) as { investigation: number } | undefined;
  return row?.investigation === 1;
}

// Overwrites unconditionally: the refined title deliberately replaces the
// temporary first-message title once the run has generated it.
export function updateSessionTitle(sessionId: string, title: string): void {
  getDb()
    .prepare(`UPDATE sessions SET title = ? WHERE session_id = ?`)
    .run(title, sessionId);
}

function serializeCanonical(m: SessionMessage): string | null {
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

// Append a turn's messages atomically: UNIQUE(session_id, seq) forbids a duplicate seq, and
// the transaction makes the turn all-or-nothing so the transcript checkpoint never holds a hole.
export function appendSessionMessages(messages: SessionMessage[]): void {
  if (messages.length === 0) return;
  const insert = getDb().prepare(
    `INSERT INTO session_messages
       (session_id, seq, role, content, canonical, created_at)
     VALUES (@sessionId, @seq, @role, @content, @canonical, @createdAt)`,
  );
  const insertAll = getDb().transaction((rows: SessionMessage[]) => {
    for (const m of rows) {
      insert.run({
        sessionId: m.sessionId,
        seq: m.seq,
        role: m.role,
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
       FROM session_messages WHERE session_id = ?`,
    )
    .get(sessionId) as { next: number };
  return row.next;
}

// NightWarden's own failure note, appended after the turn that died. Display
// and history only; buildSeed keeps it away from the model.
export function appendErrorMessage(
  sessionId: string,
  text: string,
): SessionMessage {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO session_messages
       (session_id, seq, role, content, canonical, created_at)
     VALUES (@sessionId, @seq, 'error', @content, NULL, @createdAt)`,
  );
  const message: SessionMessage = {
    sessionId,
    seq: 0,
    role: "error",
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
export function appendMessagesAndInterrupt(
  messages: SessionMessage[],
  pendingHumanInput: PendingHumanInput,
): void {
  const insertMsg = getDb().prepare(
    `INSERT INTO session_messages
       (session_id, seq, role, content, canonical, created_at)
     VALUES (@sessionId, @seq, @role, @content, @canonical, @createdAt)`,
  );
  const insertHumanInput = getDb().prepare(
    `INSERT INTO pending_human_input
       (session_id, tool_use_id, kind, tool_name, tool_input, completed_results, claimed_at, created_at)
     VALUES (@sessionId, @toolUseId, @kind, @toolName, @toolInput, @completedResults, @claimedAt, @createdAt)`,
  );
  const txn = getDb().transaction(() => {
    for (const m of messages) {
      insertMsg.run({
        sessionId: m.sessionId,
        seq: m.seq,
        role: m.role,
        content: m.content,
        canonical: serializeCanonical(m),
        createdAt: m.createdAt,
      });
    }
    insertHumanInput.run({
      sessionId: pendingHumanInput.sessionId,
      toolUseId: pendingHumanInput.toolUseId,
      kind: pendingHumanInput.kind,
      toolName: pendingHumanInput.toolName,
      toolInput: JSON.stringify(pendingHumanInput.toolInput),
      completedResults: JSON.stringify(pendingHumanInput.completedResults),
      claimedAt: pendingHumanInput.claimedAt ?? null,
      createdAt: pendingHumanInput.createdAt,
    });
  });
  txn();
}

// Cascades to the transcript and pending approval; the remediation audit log
// is not a child of sessions, so it survives.
export function deleteSession(sessionId: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
}

// Raw material for the sessions queue: one row per session joined with its
// report and the transcript's tail. Derivation into queue fields (status,
// title precedence) lives in session/list.ts, which also knows the dispatcher.
export interface SessionListSource {
  sessionId: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  originatingAlert: NormalizedAlert | null;
  investigation: boolean;
  report: Report | null;
  lastRole: string | null;
}

export function listSessionSources(): SessionListSource[] {
  const rows = getDb()
    .prepare(
      `SELECT s.session_id AS sessionId, s.title, s.created_at AS createdAt,
              s.originating_alert AS originatingAlert, s.investigation, r.report,
              (SELECT m.role FROM session_messages m
                WHERE m.session_id = s.session_id
                ORDER BY m.seq DESC LIMIT 1) AS lastRole,
              COALESCE((SELECT MAX(m.created_at) FROM session_messages m
                WHERE m.session_id = s.session_id), s.created_at) AS lastActivityAt
       FROM sessions s
       LEFT JOIN reports r ON r.session_id = s.session_id
       ORDER BY lastActivityAt DESC LIMIT 100`,
    )
    .all() as Array<{
    sessionId: string;
    title: string;
    createdAt: string;
    lastActivityAt: string;
    originatingAlert: string | null;
    investigation: number;
    report: string | null;
    lastRole: string | null;
  }>;
  return rows.map((r) => ({
    sessionId: r.sessionId,
    title: r.title,
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
    originatingAlert:
      r.originatingAlert !== null
        ? (JSON.parse(r.originatingAlert) as NormalizedAlert)
        : null,
    investigation: r.investigation === 1,
    report: r.report !== null ? (JSON.parse(r.report) as Report) : null,
    lastRole: r.lastRole,
  }));
}

export function getSession(sessionId: string): StoredSession | undefined {
  const row = getDb()
    .prepare(
      `SELECT session_id AS sessionId, title, investigation,
              originating_alert AS originatingAlert, created_at AS createdAt
       FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as
    | (SessionMeta & { originatingAlert: string | null; investigation: number })
    | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.sessionId,
    title: row.title,
    createdAt: row.createdAt,
    investigation: row.investigation === 1,
    // Stored as JSON text; only this layer deserializes it.
    originatingAlert:
      row.originatingAlert != null
        ? (JSON.parse(row.originatingAlert) as NormalizedAlert)
        : null,
  };
}

export function getSessionMessages(sessionId: string): SessionMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id AS sessionId, seq, role, content,
              canonical, created_at AS createdAt
       FROM session_messages WHERE session_id = ? ORDER BY seq ASC`,
    )
    .all(sessionId) as Array<{
    sessionId: string;
    seq: number;
    role: string;
    content: string;
    canonical: string | null;
    createdAt: string;
  }>;
  return rows.map((r) => ({
    sessionId: r.sessionId,
    // role is constrained to SessionRole on write; the column is plain TEXT.
    role: r.role as SessionMessage["role"],
    seq: r.seq,
    content: r.content,
    ...parseCanonical(r.canonical),
    createdAt: r.createdAt,
  }));
}
