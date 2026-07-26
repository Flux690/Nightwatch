import type { SessionMessage } from "@nightwarden/shared";
import { getSessionMessages } from "../db/sessions.js";
import type { ProviderMessage } from "../llm/types.js";

function hasToolCall(message: SessionMessage): boolean {
  return message.parts.some((p) => p.type === "tool_call");
}

// Replays the durable transcript for a resumed run. An error row and the dead
// exchange it terminates never reach the model: everything back to the last
// clean assistant turn (no pending tool call) is dropped with it.
export function buildSeed(sessionId: string): ProviderMessage[] {
  const rows: SessionMessage[] = [];
  for (const message of getSessionMessages(sessionId)) {
    if (message.role !== "error") {
      rows.push(message);
      continue;
    }
    while (rows.length > 0) {
      const last = rows[rows.length - 1];
      if (last?.role === "assistant" && !hasToolCall(last)) break;
      rows.pop();
    }
  }
  return rows.flatMap((m) =>
    m.role === "error"
      ? []
      : [
          {
            role: m.role,
            content: m.content,
            parts: m.parts,
            ...(m.native && { native: m.native }),
          },
        ],
  );
}
