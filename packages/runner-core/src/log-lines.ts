import type { LogLine } from "@nightwarden/shared";

// Both engines prefix each line with RFC3339 when asked for timestamps, and
// neither offers the two apart.
const STAMPED = /^(\d{4}-\d{2}-\d{2}T\S+) (.*)$/s;

// A line the engine stamped nothing on keeps its whole text and no time:
// inventing one would date evidence by when it happened to be read.
export function toLogLines(lines: string[]): LogLine[] {
  return lines.map((raw) => {
    const match = STAMPED.exec(raw);
    if (match === null) return { ts: "", line: raw };
    const at = new Date(match[1]!);
    return Number.isNaN(at.getTime())
      ? { ts: "", line: raw }
      : { ts: at.toISOString(), line: match[2]! };
  });
}
