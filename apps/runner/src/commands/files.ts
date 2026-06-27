import { openAllowedFile, redactSecrets } from "../safety/allowlist.js";
import type { ReadFileInput, ReadFileResult } from "@nightwatch/shared";

export async function readFileCommand(
  input: ReadFileInput,
): Promise<ReadFileResult> {
  // Open-then-validate closes the check/open symlink race; reads come from the
  // pinned handle, never re-resolving input.path.
  const handle = await openAllowedFile(input.path);
  let raw: string;
  try {
    raw = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

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
