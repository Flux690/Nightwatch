import { readFile, writeFile } from "node:fs/promises";
import { ReadRequiredError } from "../errors.js";
import { assertContained, resolveRepoPath } from "../paths.js";
import type { Workspace } from "../workspace.js";
import { computeDiffHunks, type DiffHunk } from "./diff.js";

export interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface FileChangeResult {
  path: string;
  hunks: DiffHunk[];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export async function editRepoFile(
  ws: Workspace,
  input: EditFileInput,
): Promise<FileChangeResult> {
  const abs = resolveRepoPath(ws.dir, input.path);
  await assertContained(ws.dir, abs);
  if (!ws.readPaths.has(abs)) throw new ReadRequiredError(input.path);
  if (input.old_string.length === 0) {
    throw new Error("old_string must not be empty.");
  }
  if (input.old_string === input.new_string) {
    throw new Error(
      "old_string and new_string are identical - nothing to change.",
    );
  }

  let before: string;
  try {
    before = await readFile(abs, "utf8");
  } catch {
    throw new Error(`File not found in the repository: ${input.path}.`);
  }

  const occurrences = countOccurrences(before, input.old_string);
  if (occurrences === 0) {
    throw new Error(
      `old_string was not found in ${input.path}. Re-read the file - it may have changed - and match the current content exactly.`,
    );
  }
  if (occurrences > 1 && input.replace_all !== true) {
    throw new Error(
      `old_string appears ${occurrences} times in ${input.path}. Add surrounding context to make it unique, or pass replace_all: true.`,
    );
  }

  const after =
    input.replace_all === true
      ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, input.new_string);
  await writeFile(abs, after, "utf8");
  return { path: input.path, hunks: computeDiffHunks(before, after) };
}
