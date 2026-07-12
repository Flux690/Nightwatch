import { diffArrays } from "diff";

const CONTEXT_LINES = 3;

export type DiffLineType = "added" | "removed" | "unchanged";
export interface DiffLine {
  type: DiffLineType;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}
export interface DiffHunk {
  lines: DiffLine[];
}

export function computeDiffHunks(
  before: string | null,
  after: string,
): DiffHunk[] {
  const oldLines = before === null ? [] : before.split("\n");
  const newLines = after.split("\n");

  const flat: DiffLine[] = [];
  let oldLineNumber = 0;
  let newLineNumber = 0;
  for (const change of diffArrays(oldLines, newLines)) {
    if (change.added) {
      for (const content of change.value) {
        newLineNumber++;
        flat.push({
          type: "added",
          oldLineNumber: null,
          newLineNumber,
          content,
        });
      }
    } else if (change.removed) {
      for (const content of change.value) {
        oldLineNumber++;
        flat.push({
          type: "removed",
          oldLineNumber,
          newLineNumber: null,
          content,
        });
      }
    } else {
      for (const content of change.value) {
        oldLineNumber++;
        newLineNumber++;
        flat.push({ type: "unchanged", oldLineNumber, newLineNumber, content });
      }
    }
  }

  return windowHunks(flat);
}

// Keeps only a few unchanged lines around each change, for orientation. Two
// changes whose kept windows touch merge into a single hunk automatically -
// there is nothing left to drop between them.
function windowHunks(flat: DiffLine[]): DiffHunk[] {
  const keep = new Array<boolean>(flat.length).fill(false);
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].type === "unchanged") continue;
    const from = Math.max(0, i - CONTEXT_LINES);
    const to = Math.min(flat.length - 1, i + CONTEXT_LINES);
    for (let j = from; j <= to; j++) keep[j] = true;
  }

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  for (let i = 0; i < flat.length; i++) {
    if (!keep[i]) {
      if (current.length > 0) {
        hunks.push({ lines: current });
        current = [];
      }
      continue;
    }
    current.push(flat[i]);
  }
  if (current.length > 0) hunks.push({ lines: current });

  return hunks;
}
