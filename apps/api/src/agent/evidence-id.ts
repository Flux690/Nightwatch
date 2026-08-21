import type { TranscriptRow } from "@nightwarden/shared";

/* The handle the model cites a call by, because the provider's own id appears
   nowhere it reads as content. Nothing is stored: e3 is the third tool call in
   the transcript, so rendering it and resolving it count the same way. */
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

// The line put in front of a tool result so the model can read its own handle.
// Restated from the call rather than described, so it cannot drift from it.
export function evidenceHeader(
  evidenceId: string,
  toolName: string,
  input: Record<string, unknown>,
): string {
  const aim = ["target", "runner", "query", "path", "metric", "contains"]
    .map((key) => input[key])
    .find((value) => typeof value === "string" && value.trim() !== "");
  const label = typeof aim === "string" ? ` \u00b7 ${aim}` : "";
  return `[${evidenceId} \u00b7 ${toolName}${label}]`;
}
