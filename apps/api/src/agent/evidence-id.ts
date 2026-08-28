import type { TranscriptRow } from "@nightwarden/shared";
import { isCitable } from "./evidence-source.js";

// The provider's own id appears nowhere the model reads. Stored rather than
// counted, so two readers cannot derive a different number for one call.
const PREFIX = "e";

function numberOf(evidenceId: string | undefined): number {
  if (evidenceId === undefined || !evidenceId.startsWith(PREFIX)) return 0;
  const n = Number(evidenceId.slice(PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// Read from what was stamped, so a refusal offers a range that exists.
export function highestEvidenceNumber(rows: readonly TranscriptRow[]): number {
  let highest = 0;
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.type !== "tool_call") continue;
      highest = Math.max(highest, numberOf(part.evidenceId));
    }
  }
  return highest;
}

// Stamped on the way to disk, so one walk owns the numbering and a handle
// survives a later change to which tools a claim may rest on.
export function withEvidenceIds(
  rows: TranscriptRow[],
  from: number,
): TranscriptRow[] {
  let next = from;
  return rows.map((row) => ({
    ...row,
    parts: row.parts.map((part) =>
      part.type === "tool_call" && isCitable(part.name)
        ? { ...part, evidenceId: `${PREFIX}${next++}` }
        : part,
    ),
  }));
}

export function evidenceIdsIn(
  rows: readonly TranscriptRow[],
): Map<string, string> {
  const byToolUseId = new Map<string, string>();
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.type === "tool_call" && part.evidenceId !== undefined) {
        byToolUseId.set(part.id, part.evidenceId);
      }
    }
  }
  return byToolUseId;
}
