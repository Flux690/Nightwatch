import type { TranscriptRow } from "@nightwarden/shared";
import { getTranscriptRows } from "./transcript-store.js";
import type { ProviderMessage } from "../llm/types.js";

function hasToolCall(message: TranscriptRow): boolean {
  return message.parts.some((p) => p.type === "tool_call");
}

// Every provider rejects a conversation ending on an unanswered tool_use.
// `resuming` names the calls this dispatch answers, so their turn survives.
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

// Maps our four kinds onto the provider's two roles. An error row and the dead
// exchange it terminates drop back to the last clean assistant turn.
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
