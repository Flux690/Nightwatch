import type {
  NormalizedAlert,
  SessionMessage,
  SessionMeta,
} from "@nightwatch/shared";
import { getDb } from "./client.js";
import type { PendingHumanInput } from "./interrupts.js";

// A session row plus its originating alert (null for chat sessions). The alert is
// the durable source of severity-dependent behavior on resume, so a run that no
// longer carries the alert in its job can recover it from here.
export type StoredSession = SessionMeta & {
  originatingAlert: NormalizedAlert | null;
};

// Create the session row once. Idempotent: a resume re-enters the loop with the
// same id, and the first title/alert win - later runs never clobber them.
export function createSession(
  meta: SessionMeta,
  originatingAlert: NormalizedAlert | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (session_id, title, originating_alert, created_at)
       VALUES (@sessionId, @title, @originatingAlert, @createdAt)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .run({
      sessionId: meta.sessionId,
      title: meta.title,
      originatingAlert:
        originatingAlert != null ? JSON.stringify(originatingAlert) : null,
      createdAt: meta.createdAt,
    });
}

// Append one turn's worth of messages atomically. The UNIQUE(session_id, seq)
// constraint makes a duplicate seq impossible; wrapping the batch in a
// transaction makes the whole turn all-or-nothing so a partial turn can never be
// persisted (the transcript is the checkpoint - it must never hold a hole).
export function appendSessionMessages(messages: SessionMessage[]): void {
  if (messages.length === 0) return;
  const insert = getDb().prepare(
    `INSERT INTO session_messages
       (session_id, seq, role, content, provider_content, created_at)
     VALUES (@sessionId, @seq, @role, @content, @providerContent, @createdAt)`,
  );
  const insertAll = getDb().transaction((rows: SessionMessage[]) => {
    for (const m of rows) {
      insert.run({
        sessionId: m.sessionId,
        seq: m.seq,
        role: m.role,
        content: m.content,
        providerContent:
          m.providerContent != null ? JSON.stringify(m.providerContent) : null,
        createdAt: m.createdAt,
      });
    }
  });
  insertAll(messages);
}

// Atomically persist the assistant turn messages AND the interrupt row in one
// transaction. The loop calls this when suspending on a gated tool so the DB
// is always in a consistent state: both exist or neither does (D3).
export function appendMessagesAndInterrupt(
  messages: SessionMessage[],
  pendingHumanInput: PendingHumanInput,
): void {
  const insertMsg = getDb().prepare(
    `INSERT INTO session_messages
       (session_id, seq, role, content, provider_content, created_at)
     VALUES (@sessionId, @seq, @role, @content, @providerContent, @createdAt)`,
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
        providerContent:
          m.providerContent != null ? JSON.stringify(m.providerContent) : null,
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

export function listAllSessions(): SessionMeta[] {
  return getDb()
    .prepare(
      `SELECT session_id AS sessionId, title, created_at AS createdAt
       FROM sessions ORDER BY created_at DESC LIMIT 100`,
    )
    .all() as SessionMeta[];
}

export function getSession(sessionId: string): StoredSession | undefined {
  const row = getDb()
    .prepare(
      `SELECT session_id AS sessionId, title,
              originating_alert AS originatingAlert, created_at AS createdAt
       FROM sessions WHERE session_id = ?`,
    )
    .get(sessionId) as
    | (StoredSession & { originatingAlert: string | null })
    | undefined;
  if (!row) return undefined;
  return {
    sessionId: row.sessionId,
    title: row.title,
    createdAt: row.createdAt,
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

export function appendSyntheticAssistantMessage(
  sessionId: string,
  content: string,
): SessionMessage {
  const nextSeq =
    ((getDb()
      .prepare(`SELECT MAX(seq) AS maxSeq FROM session_messages WHERE session_id = ?`)
      .get(sessionId) as { maxSeq: number | null }).maxSeq ?? -1) + 1;
  const message: SessionMessage = {
    sessionId,
    seq: nextSeq,
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
  };
  appendSessionMessages([message]);
  return message;
}
