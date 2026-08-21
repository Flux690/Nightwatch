import type { TranscriptRow } from "@nightwarden/shared";
import { getTranscriptRows } from "../db/sessions.js";
import type { ProviderMessage } from "../llm/types.js";

function hasToolCall(message: TranscriptRow): boolean {
  return message.parts.some((p) => p.type === "tool_call");
}

/* A conversation ending on an unanswered `tool_use` is one every provider
   rejects, and it is what a crash between writing the assistant turn and running
   its tools leaves. Later turns go too: keeping them keeps the unanswered call.

   `resuming` names the calls this dispatch is about to answer: the gate, and
   every sibling that ran beside it in the same turn. They are unanswered on
   purpose, and dropping their turn would send results for calls the model can
   no longer see it made. */
function throughLastAnsweredExchange(
  rows: TranscriptRow[],
  resuming: readonly string[],
): TranscriptRow[] {
  const answered = new Set<string>(resuming);
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.type === "tool_result") answered.add(part.toolCallId);
    }
  }
  for (let i = 0; i < rows.length; i++) {
    for (const part of rows[i]!.parts) {
      if (part.type === "tool_call" && !answered.has(part.id)) {
        return rows.slice(0, i);
      }
    }
  }
  return rows;
}

/* Replays the durable transcript for a resumed run, mapping our four kinds onto
   the provider's two roles. An error row and the dead exchange it terminates are
   dropped back to the last clean assistant turn; a harness row returns as user.

   `resuming` names the calls whose results this dispatch is about to append, so
   the turn that made them survives the unwind above. */
export function buildSeed(
  sessionId: string,
  resuming: readonly string[] = [],
): ProviderMessage[] {
  const rows: TranscriptRow[] = [];
  for (const message of getTranscriptRows(sessionId)) {
    if (message.kind !== "error") {
      rows.push(message);
      continue;
    }
    /* Never replayed: whatever killed that exchange - a context window it no
       longer fits in, a request the provider refused - would kill it again. */
    while (rows.length > 0) {
      const last = rows[rows.length - 1];
      if (last?.kind === "assistant" && !hasToolCall(last)) break;
      rows.pop();
    }
  }
  return throughLastAnsweredExchange(rows, resuming).map((m) => ({
    role: m.kind === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.content,
    parts: m.parts,
    ...(m.native && { native: m.native }),
  }));
}
