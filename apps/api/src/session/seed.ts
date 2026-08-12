import type { TranscriptRow } from "@nightwarden/shared";
import { getTranscriptRows } from "../db/sessions.js";
import type { ProviderMessage } from "../llm/types.js";

function hasToolCall(message: TranscriptRow): boolean {
  return message.parts.some((p) => p.type === "tool_call");
}

/* Everything from the first call nothing answered onward. A conversation ending
   on an unanswered `tool_use` is one every provider rejects outright, which is
   what a crash between writing the assistant turn and running its tools leaves
   behind. Turns after it go too: keeping them would keep the unanswered call. */
function throughLastAnsweredExchange(rows: TranscriptRow[]): TranscriptRow[] {
  const answered = new Set<string>();
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

// Replays the durable transcript for a resumed run, mapping our four kinds onto
// the provider's two roles. An error row and the dead exchange it terminates are
// dropped back to the last clean assistant turn; a harness row returns as user.
export function buildSeed(sessionId: string): ProviderMessage[] {
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
  return throughLastAnsweredExchange(rows).map((m) => ({
    role: m.kind === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.content,
    parts: m.parts,
    ...(m.native && { native: m.native }),
  }));
}
