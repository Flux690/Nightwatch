import type {
  MessagePart,
  NativeEnvelope,
  TranscriptRow,
} from "@nightwarden/shared";
import { getDb } from "../db.js";
import type { PendingHumanInput } from "./interrupts.js";

// Transcript rows, appended a turn at a time.

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

// The newest row's timestamp, kept on the session because the queue sorts on it.
// Written inside each appender's transaction, so it cannot fall behind the
// transcript it summarises.
function touchSession(sessionId: string, at: string): void {
  getDb()
    .prepare(
      `UPDATE sessions SET last_activity_at = @at WHERE session_id = @sessionId`,
    )
    .run({ sessionId, at });
}

// Append a turn's rows atomically: the (session_id, seq) primary key forbids a
// duplicate seq, and the transaction makes the turn all-or-nothing so the
// transcript checkpoint never holds a hole.
export function appendTranscriptRows(messages: TranscriptRow[]): void {
  if (messages.length === 0) return;
  const insert = getDb().prepare(
    `INSERT INTO session_transcript
       (session_id, seq, kind, content, canonical, timestamp)
     VALUES (@sessionId, @seq, @kind, @content, @canonical, @timestamp)`,
  );
  const insertAll = getDb().transaction((rows: TranscriptRow[]) => {
    for (const m of rows) {
      insert.run({
        sessionId: m.sessionId,
        seq: m.seq,
        kind: m.kind,
        content: m.content,
        canonical: serializeCanonical(m),
        timestamp: m.timestamp,
      });
    }
    const last = rows[rows.length - 1];
    if (last) touchSession(last.sessionId, last.timestamp);
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
       (session_id, seq, kind, content, canonical, timestamp)
     VALUES (@sessionId, @seq, 'error', @content, NULL, @timestamp)`,
  );
  const message: TranscriptRow = {
    sessionId,
    seq: 0,
    kind: "error",
    content: text,
    parts: [],
    timestamp: new Date().toISOString(),
  };
  db.transaction(() => {
    message.seq = getNextSeq(sessionId);
    insert.run({
      sessionId,
      seq: message.seq,
      content: text,
      timestamp: message.timestamp,
    });
    touchSession(sessionId, message.timestamp);
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
       (session_id, seq, kind, content, canonical, timestamp)
     VALUES (@sessionId, @seq, @kind, @content, @canonical, @timestamp)`,
  );
  // Suspending is the gate, so the state keeping this session's seat is
  // written with it: the two are columns on the same row.
  const suspend = getDb().prepare(
    `UPDATE sessions
        SET run_state = 'suspended', awaiting_tool_use_id = @toolUseId,
            awaiting_kind = @kind, awaiting_results = @completedResults,
            attempt_started_at = @claimedAt
      WHERE session_id = @sessionId`,
  );
  const txn = getDb().transaction(() => {
    for (const m of messages) {
      insertMsg.run({
        sessionId: m.sessionId,
        seq: m.seq,
        kind: m.kind,
        content: m.content,
        canonical: serializeCanonical(m),
        timestamp: m.timestamp,
      });
    }
    suspend.run({
      sessionId: pendingHumanInput.sessionId,
      toolUseId: pendingHumanInput.toolUseId,
      kind: pendingHumanInput.kind,
      completedResults: JSON.stringify(pendingHumanInput.completedResults),
      claimedAt: pendingHumanInput.claimedAt ?? null,
    });
    const last = messages[messages.length - 1];
    if (last) touchSession(last.sessionId, last.timestamp);
  });
  txn();
}

/* The other half of appendRowsAndInterrupt: the answered turn and the cleared
   gate in one transaction, so a crash between them cannot lose the result of a
   command that has already run. False when another request cleared it first. */
export function appendRowsAndResolve(
  sessionId: string,
  messages: TranscriptRow[],
): boolean {
  const insert = getDb().prepare(
    `INSERT INTO session_transcript
       (session_id, seq, kind, content, canonical, timestamp)
     VALUES (@sessionId, @seq, @kind, @content, @canonical, @timestamp)`,
  );
  const clear = getDb().prepare(
    `UPDATE sessions
        SET awaiting_tool_use_id = NULL, awaiting_kind = NULL,
            awaiting_results = '[]', attempt_started_at = NULL
      WHERE session_id = ? AND awaiting_tool_use_id IS NOT NULL`,
  );
  return getDb().transaction((): boolean => {
    // Cleared first, so a loser writes nothing rather than a duplicate turn.
    if (clear.run(sessionId).changes === 0) return false;
    for (const m of messages) {
      insert.run({
        sessionId: m.sessionId,
        seq: m.seq,
        kind: m.kind,
        content: m.content,
        canonical: serializeCanonical(m),
        timestamp: m.timestamp,
      });
    }
    const last = messages[messages.length - 1];
    if (last) touchSession(last.sessionId, last.timestamp);
    return true;
  })();
}

export function getTranscriptRows(sessionId: string): TranscriptRow[] {
  const rows = getDb()
    .prepare(
      `SELECT session_id AS sessionId, seq, kind, content,
              canonical, timestamp
       FROM session_transcript WHERE session_id = ? ORDER BY seq ASC`,
    )
    .all(sessionId) as Array<{
    sessionId: string;
    seq: number;
    kind: string;
    content: string;
    canonical: string | null;
    timestamp: string;
  }>;
  return rows.map((r) => ({
    sessionId: r.sessionId,
    // kind is constrained to TranscriptKind on write; the column is plain TEXT.
    kind: r.kind as TranscriptRow["kind"],
    seq: r.seq,
    content: r.content,
    ...parseCanonical(r.canonical),
    timestamp: r.timestamp,
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
