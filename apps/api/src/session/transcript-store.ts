import type {
  MessagePart,
  NativeEnvelope,
  TranscriptRow,
} from "@nightwarden/shared";
import { getDb, type Db } from "../db.js";
import { refreshSessionStatus } from "./status-store.js";
import type { PendingHumanInput } from "./gate-store.js";

// Transcript rows, appended a turn at a time.

function serializeCanonical(m: TranscriptRow): string | null {
  if (m.parts.length === 0 && m.native === undefined) return null;
  return JSON.stringify({ parts: m.parts, native: m.native });
}

// Untrusted on read despite being our own INSERT: a partial write or a schema
// change should surface as an empty turn, never crash a transcript or a resume.
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

// Written inside each appender's transaction, so the stamp the queue sorts on
// cannot fall behind the transcript it summarises.
async function touchSession(
  db: Db,
  sessionId: string,
  at: string,
): Promise<void> {
  await db
    .updateTable("sessions")
    .set({ last_activity_at: at })
    .where("session_id", "=", sessionId)
    .execute();
}

function rowValues(m: TranscriptRow) {
  return {
    session_id: m.sessionId,
    seq: m.seq,
    kind: m.kind,
    content: m.content,
    canonical: serializeCanonical(m),
    timestamp: m.timestamp,
  };
}

// The (session_id, seq) primary key forbids a duplicate seq and the transaction
// makes the turn all-or-nothing, so the checkpoint never holds a hole.
export async function appendTranscriptRows(
  messages: TranscriptRow[],
): Promise<void> {
  if (messages.length === 0) return;
  await getDb()
    .transaction()
    .execute(async (trx) => {
      if (messages.length > 0) {
        await trx
          .insertInto("session_transcript")
          .values(messages.map(rowValues))
          .execute();
      }
      const last = messages[messages.length - 1];
      if (last) {
        await touchSession(trx, last.sessionId, last.timestamp);
        // The tail decides whether a session reads as failed, so appending to
        // it can change the answer. A no-op while a run holds 'running'.
        await refreshSessionStatus(last.sessionId, trx);
      }
    });
}

export async function getNextSeq(
  sessionId: string,
  db: Db = getDb(),
): Promise<number> {
  const row = await db
    .selectFrom("session_transcript")
    .select((eb) => eb.fn.max<number | null>("seq").as("highest"))
    .where("session_id", "=", sessionId)
    .executeTakeFirst();
  return (row?.highest ?? -1) + 1;
}

// NightWarden's own failure note, appended after the turn that died. Display
// and history only; buildSeed keeps it away from the model.
export async function appendErrorMessage(
  sessionId: string,
  text: string,
): Promise<TranscriptRow> {
  const message: TranscriptRow = {
    sessionId,
    seq: 0,
    kind: "error",
    content: text,
    parts: [],
    timestamp: new Date().toISOString(),
  };
  await getDb()
    .transaction()
    .execute(async (trx) => {
      message.seq = await getNextSeq(sessionId, trx);
      await trx
        .insertInto("session_transcript")
        .values(rowValues(message))
        .execute();
      await touchSession(trx, sessionId, message.timestamp);
      // An error row is what makes a session read as failed. A no-op while the
      // run still holds 'running', where releaseRun derives the same later.
      await refreshSessionStatus(sessionId, trx);
    });
  return message;
}

// Called when suspending on a gated tool, so the database is always consistent:
// both the messages and the gate exist, or neither does.
export async function appendRowsAndPark(
  messages: TranscriptRow[],
  pendingHumanInput: PendingHumanInput,
): Promise<void> {
  await getDb()
    .transaction()
    .execute(async (trx) => {
      if (messages.length > 0) {
        await trx
          .insertInto("session_transcript")
          .values(messages.map(rowValues))
          .execute();
      }
      // Suspending is the gate, so the status keeping this session's seat is
      // written with it: the two are columns on the same row.
      await trx
        .updateTable("sessions")
        .set({
          status: "action_required",
          awaiting_tool_use_id: pendingHumanInput.toolUseId,
          awaiting_kind: pendingHumanInput.kind,
          awaiting_results: JSON.stringify(pendingHumanInput.completedResults),
          attempt_started_at: pendingHumanInput.claimedAt ?? null,
        })
        .where("session_id", "=", pendingHumanInput.sessionId)
        .execute();
      const last = messages[messages.length - 1];
      if (last) await touchSession(trx, last.sessionId, last.timestamp);
    });
}

/* The answered turn and the cleared gate in one transaction, so a crash between
   them cannot lose the result of a command that already ran. */
export async function appendRowsAndResolve(
  sessionId: string,
  messages: TranscriptRow[],
): Promise<boolean> {
  return await getDb()
    .transaction()
    .execute(async (trx) => {
      // Cleared first, so a loser writes nothing rather than a duplicate turn.
      const cleared = await trx
        .updateTable("sessions")
        .set({
          awaiting_tool_use_id: null,
          awaiting_kind: null,
          awaiting_results: "[]",
          attempt_started_at: null,
        })
        .where("session_id", "=", sessionId)
        .where("awaiting_tool_use_id", "is not", null)
        .executeTakeFirst();
      if (Number(cleared.numUpdatedRows) === 0) return false;
      if (messages.length > 0) {
        await trx
          .insertInto("session_transcript")
          .values(messages.map(rowValues))
          .execute();
      }
      const last = messages[messages.length - 1];
      if (last) await touchSession(trx, last.sessionId, last.timestamp);
      // The gate is gone, so 'action_required' is no longer true. The resume
      // that follows claims 'running' over whatever this settles on.
      await refreshSessionStatus(sessionId, trx);
      return true;
    });
}

export async function getTranscriptRows(
  sessionId: string,
): Promise<TranscriptRow[]> {
  const rows = await getDb()
    .selectFrom("session_transcript")
    .select([
      "session_id as sessionId",
      "seq",
      "kind",
      "content",
      "canonical",
      "timestamp",
    ])
    .where("session_id", "=", sessionId)
    .orderBy("seq", "asc")
    .execute();
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
export async function findToolCall(
  sessionId: string,
  toolUseId: string,
): Promise<{ name: string; input: Record<string, unknown> } | null> {
  for (const row of await getTranscriptRows(sessionId)) {
    for (const part of row.parts) {
      if (part.type === "tool_call" && part.id === toolUseId) {
        return { name: part.name, input: part.input };
      }
    }
  }
  return null;
}
