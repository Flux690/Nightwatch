import { posix } from "node:path";
import { resolveRepoPath } from "../paths.js";
import type { ExecOutcome, Workspace } from "../workspace.js";

export interface ExecInput {
  command: string;
  cwd?: string;
}

export interface ExecToolResult extends ExecOutcome {
  timedOut: boolean;
}

export async function execInRepo(
  ws: Workspace,
  input: ExecInput,
  timeoutMs: number,
): Promise<ExecToolResult> {
  let containerCwd: string | undefined;
  if (input.cwd !== undefined && input.cwd !== "") {
    // Validated against the host workspace for escapes, then re-rooted at the
    // container's mount point.
    resolveRepoPath(ws.dir, input.cwd);
    containerCwd = posix.join("/workspace", input.cwd);
  }
  const result = await ws.exec(input.command, {
    ...(containerCwd !== undefined && { cwd: containerCwd }),
    timeoutMs,
  });
  // coreutils `timeout` exits 124 when the deadline killed the command.
  const timedOut = result.exitCode === 124;
  return {
    ...result,
    output: timedOut
      ? `${result.output}\n(command timed out after ${Math.round(timeoutMs / 1000)}s)`
      : result.output,
    timedOut,
  };
}
