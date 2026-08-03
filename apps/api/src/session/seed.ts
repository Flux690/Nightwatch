import type { TranscriptRow } from "@nightwarden/shared";
import { getTranscriptRows } from "../db/sessions.js";
import type { ProviderMessage } from "../llm/types.js";

function hasToolCall(message: TranscriptRow): boolean {
  return message.parts.some((p) => p.type === "tool_call");
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
    while (rows.length > 0) {
      const last = rows[rows.length - 1];
      if (last?.kind === "assistant" && !hasToolCall(last)) break;
      rows.pop();
    }
  }
  return rows.flatMap((m) =>
    m.kind === "error"
      ? []
      : [
          {
            role: m.kind === "assistant" ? "assistant" : "user",
            content: m.content,
            parts: m.parts,
            ...(m.native && { native: m.native }),
          },
        ],
  );
}
