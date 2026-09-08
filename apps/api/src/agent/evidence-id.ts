import type { ToolResultPart, TranscriptRow } from "@nightwarden/shared";
import type { ToolResult } from "../llm/types.js";

// The provider's own id appears nowhere the model reads. Stored rather than
// counted, so two readers cannot derive a different number for one call.
const PREFIX = "e";

export function evidenceNumber(evidenceId: string | undefined): number {
  if (evidenceId === undefined || !evidenceId.startsWith(PREFIX)) return 0;
  const n = Number(evidenceId.slice(PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// Read from what was stamped, so a refusal offers a range that exists.
export function highestEvidenceNumber(rows: readonly TranscriptRow[]): number {
  let highest = 0;
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.type !== "tool_result") continue;
      highest = Math.max(highest, evidenceNumber(part.evidenceId));
    }
  }
  return highest;
}

/* Stamped as the answer is built, which is the moment the evidence exists, so a
   call made in this same reply and one that never answered both carry none. */
export function resultParts(
  results: readonly ToolResult[],
  citable: ReadonlySet<string>,
  from: number,
): { parts: ToolResultPart[]; next: number } {
  let next = from;
  const parts = results.map((result): ToolResultPart => {
    const cited = citable.has(result.toolCallId) && result.isError !== true;
    return {
      type: "tool_result",
      toolCallId: result.toolCallId,
      output: result.content,
      ...(cited && { evidenceId: `${PREFIX}${next++}` }),
      ...(result.isError === true && { isError: true }),
    };
  });
  return { parts, next };
}
