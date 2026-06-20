import { readFile } from "node:fs/promises";
import { isPathAllowed, redactSecrets } from "../safety/allowlist.js";
import type { ReadFileInput, ReadFileResult } from "@nightwatch/shared";

export async function readFileCommand(
  input: ReadFileInput,
): Promise<ReadFileResult> {
  if (!isPathAllowed(input.path)) {
    throw new Error(
      `Path not in allowlist: ${input.path}. Add to FILE_ALLOWLIST env var to enable.`,
    );
  }

  const raw = await readFile(input.path, "utf8");
  const maxLines = input.maxLines ?? 500;
  const allLines = raw.split("\n");
  const sliced = allLines.slice(0, maxLines).join("\n");
  const { content, redactedCount } = redactSecrets(sliced);

  return {
    content,
    lineCount: Math.min(allLines.length, maxLines),
    path: input.path,
    redactedLineCount: redactedCount,
  };
}
