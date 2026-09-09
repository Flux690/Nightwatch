import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ReadRequiredError } from "../errors.js";
import { assertContained, repoKey, resolveRepoPath } from "../paths.js";
import type { Workspace } from "../workspace.js";
import { computeDiffHunks } from "./diff.js";
import type { FileChangeResult } from "./edit-file.js";

interface WriteFileInput {
  path: string;
  content: string;
}

export async function writeRepoFile(
  ws: Workspace,
  input: WriteFileInput,
): Promise<FileChangeResult> {
  const abs = resolveRepoPath(ws.dir, input.path);
  await assertContained(ws.dir, abs);

  let existing: string | null = null;
  try {
    existing = await readFile(abs, "utf8");
  } catch {
    // New file: creation needs no prior read - there is nothing to have read.
  }
  if (existing !== null) {
    const { seen, pending } = await ws.readState();
    const key = repoKey(input.path);
    if (!seen.has(key))
      throw new ReadRequiredError(input.path, pending.has(key));
  }

  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, input.content, "utf8");
  return {
    path: input.path,
    hunks: computeDiffHunks(existing, input.content),
  };
}
