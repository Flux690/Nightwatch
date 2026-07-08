import { execFile } from "node:child_process";
import { GitOperationError } from "./errors.js";

const GIT_TIMEOUT_MS = 5 * 60_000;
const MAX_GIT_BUFFER = 16 * 1024 * 1024;

interface GitOptions {
  cwd?: string;
  authHeader?: string;
  timeoutMs?: number;
}

function redactSecret(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text;
  return text.split(secret).join("[REDACTED]");
}

// Deliberately not util.promisify: the explicit callback keeps the execFile
// contract visible so a test double can honour it faithfully.
function runGit(args: string[], opts: GitOptions): Promise<string> {
  // Per-invocation -c never touches .git/config, so the credential exists
  // only in this process's argv for the duration of the call.
  const fullArgs =
    opts.authHeader === undefined
      ? args
      : ["-c", `http.extraHeader=Authorization: ${opts.authHeader}`, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      fullArgs,
      {
        ...(opts.cwd !== undefined && { cwd: opts.cwd }),
        timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_BUFFER,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new GitOperationError(
              redactSecret(
                `git ${args[0] ?? ""} failed: ${stderr.trim() || error.message}`,
                opts.authHeader,
              ),
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export interface CloneOptions {
  url: string;
  branch: string;
  dir: string;
  authHeader: string;
}

// Clone, then put the checkout on the session branch: a resumed session finds
// its branch on the remote and continues it; a fresh one creates it locally.
export async function cloneAndCheckout(opts: CloneOptions): Promise<void> {
  await runGit(["clone", "--no-tags", opts.url, opts.dir], {
    authHeader: opts.authHeader,
  });
  const remoteExists = await runGit(
    ["rev-parse", "--verify", `origin/${opts.branch}`],
    { cwd: opts.dir },
  ).then(
    () => true,
    () => false,
  );
  if (remoteExists) {
    await runGit(["checkout", "-B", opts.branch, `origin/${opts.branch}`], {
      cwd: opts.dir,
    });
  } else {
    await runGit(["checkout", "-b", opts.branch], { cwd: opts.dir });
  }
}

export async function isDirty(dir: string): Promise<boolean> {
  const status = await runGit(["status", "--porcelain"], { cwd: dir });
  return status.trim().length > 0;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

// Identity rides -c flags per invocation: nothing lands in the checkout's config.
export async function commitAll(
  dir: string,
  message: string,
  author: CommitAuthor,
): Promise<void> {
  await runGit(["add", "-A"], { cwd: dir });
  await runGit(
    [
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "-m",
      message,
    ],
    { cwd: dir },
  );
}

// Anything not on the remote yet counts - checkpoint commits and commits whose
// earlier push failed alike; a session that changed nothing pushes nothing and
// litters no remote branch.
export async function hasUnpushedWork(dir: string): Promise<boolean> {
  const count = await runGit(
    ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
    { cwd: dir },
  );
  return parseInt(count.trim(), 10) > 0;
}

export async function push(
  dir: string,
  branch: string,
  authHeader: string,
): Promise<void> {
  await runGit(["push", "--set-upstream", "origin", branch], {
    cwd: dir,
    authHeader,
  });
}

// Files the session's branch changed relative to where it forked from the
// remote (origin/HEAD is set by clone). Best-effort: a missing symref just
// means an empty list, never a failed PR.
export async function changedFiles(dir: string): Promise<string[]> {
  try {
    const out = await runGit(["diff", "--name-only", "origin/HEAD...HEAD"], {
      cwd: dir,
    });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}
