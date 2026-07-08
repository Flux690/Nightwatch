import { readFile } from "node:fs/promises";
import { assertContained, resolveRepoPath } from "../paths.js";
import type { Workspace } from "../workspace.js";

export interface ReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
}

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

export async function readRepoFile(
  ws: Workspace,
  input: ReadFileInput,
): Promise<string> {
  const abs = resolveRepoPath(ws.dir, input.path);
  await assertContained(ws.dir, abs);
  let raw: string;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    throw new Error(
      `File not found in the repository: ${input.path}. Check the path with repo_exec (ls, git ls-files).`,
    );
  }

  const lines = raw.split("\n");
  const offset = Math.max(1, Math.floor(input.offset ?? 1));
  const limit = Math.min(
    Math.max(1, Math.floor(input.limit ?? MAX_LINES)),
    MAX_LINES,
  );
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = slice
    .map((line, i) => {
      const shown =
        line.length > MAX_LINE_CHARS
          ? `${line.slice(0, MAX_LINE_CHARS)}... (line truncated)`
          : line;
      return `${String(offset + i).padStart(6)}\t${shown}`;
    })
    .join("\n");

  ws.readPaths.add(abs);
  const lastShown = offset - 1 + slice.length;
  return lastShown < lines.length
    ? `${numbered}\n(truncated: file continues beyond line ${lastShown} of ${lines.length})`
    : numbered;
}
