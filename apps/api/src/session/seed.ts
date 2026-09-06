import type { TranscriptRow } from "@nightwarden/shared";
import { getTranscriptRows } from "./transcript-store.js";
import type { ProviderMessage } from "../llm/types.js";

function hasToolCall(message: TranscriptRow): boolean {
  return message.parts.some((p) => p.type === "tool_call");
}

// Every provider rejects a conversation ending on an unanswered tool_use. A
// resolved gate writes its answer before it clears, so nothing is passed in.
function throughLastAnsweredExchange(rows: TranscriptRow[]): TranscriptRow[] {
  const answered = new Set<string>();
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.type === "tool_result") answered.add(part.toolCallId);
    }
  }
  for (let i = 0; i < rows.length; i++) {
    for (const part of rows[i]!.parts) {
      if (part.type === "tool_call" && !answered.has(part.toolCallId)) {
        return rows.slice(0, i);
      }
    }
  }
  return rows;
}

// Maps our four kinds onto the provider's two roles. An error row and the dead
// exchange it terminates drop back to the last clean assistant turn.
export async function buildSeed(sessionId: string): Promise<ProviderMessage[]> {
  const rows: TranscriptRow[] = [];
  for (const message of await getTranscriptRows(sessionId)) {
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
  }));
}
