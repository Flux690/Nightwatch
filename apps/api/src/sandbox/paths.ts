import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { PathEscapeError } from "./errors.js";

// Security-critical: file handlers run on the API host against the bind-mounted
// workspace, so an escaping path would reach the host filesystem.
export function resolveRepoPath(
  workspaceDir: string,
  repoRelative: string,
): string {
  if (repoRelative.length === 0 || repoRelative.includes("\0")) {
    throw new PathEscapeError(repoRelative);
  }
  if (isAbsolute(repoRelative)) throw new PathEscapeError(repoRelative);
  const normalized = normalize(repoRelative);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new PathEscapeError(repoRelative);
  }
  return join(workspaceDir, normalized);
}

// A sandboxed process can plant a symlink anywhere on the host, so lexical
// checks aren't enough - resolve the deepest existing ancestor instead.
export async function assertContained(
  workspaceDir: string,
  absolutePath: string,
): Promise<void> {
  const realRoot = await realpath(workspaceDir);
  let probe = absolutePath;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new PathEscapeError(absolutePath);
      }
      return;
    } catch (err) {
      if (err instanceof PathEscapeError) throw err;
      const parent = dirname(probe);
      if (parent === probe) throw new PathEscapeError(absolutePath);
      probe = parent;
    }
  }
}
