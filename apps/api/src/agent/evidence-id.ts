import type { TranscriptRow } from "@nightwarden/shared";

// The provider's own id appears nowhere the model reads. Nothing is stored:
// e3 is the third call, so rendering and resolving count the same way.
const PREFIX = "e";

// Calls, not results: a call that never answered still takes its number, so a
// failed tool cannot renumber everything after it.
export function evidenceIdsByToolUseId(
  rows: readonly TranscriptRow[],
): Map<string, string> {
  const byToolUseId = new Map<string, string>();
  let n = 0;
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.type !== "tool_call") continue;
      n += 1;
      byToolUseId.set(part.id, `${PREFIX}${n}`);
    }
  }
  return byToolUseId;
}
