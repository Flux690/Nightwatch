import type { SessionMessage } from "@nightwarden/shared";
import { getSessionMessages } from "../db/sessions.js";
import type { ProviderMessage } from "../llm/types.js";

// providerContent is either a block array (OpenAI) or a native message whose
// content holds the blocks (Anthropic); either way tool_use is a typed block.
function hasToolUse(message: SessionMessage): boolean {
  const native = message.providerContent;
  const blocks: unknown = Array.isArray(native)
    ? native
    : typeof native === "object" && native !== null
      ? (native as Record<string, unknown>)["content"]
      : null;
  if (!Array.isArray(blocks)) return false;
  return blocks.some(
    (b: unknown) =>
      typeof b === "object" &&
      b !== null &&
      (b as Record<string, unknown>)["type"] === "tool_use",
  );
}

// Replays the durable transcript for a resumed run. An error row and the dead
// exchange it terminates never reach the model: everything back to the last
// clean assistant turn (no pending tool_use) is dropped with it.
export function buildSeed(sessionId: string): ProviderMessage[] {
  const rows: SessionMessage[] = [];
  for (const message of getSessionMessages(sessionId)) {
    if (message.role !== "error") {
      rows.push(message);
      continue;
    }
    while (rows.length > 0) {
      const last = rows[rows.length - 1];
      if (last?.role === "assistant" && !hasToolUse(last)) break;
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
            providerContent: m.providerContent,
          },
        ],
  );
}
