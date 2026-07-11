import { VerificationFailedError } from "../errors.js";
import {
  changedFiles,
  commitAll,
  hasUnpushedWork,
  isDirty,
  push,
} from "../git.js";
import type { Workspace } from "../workspace.js";

// What actually happened, reported verbatim in the PR body: either the
// agent-supplied command ran (exit 0, or the PR was refused), or why not.
export interface VerificationOutcome {
  ran: boolean;
  command?: string;
  output?: string;
  reason?: string;
}

export interface OpenPullRequestOutcome {
  action: "created" | "updated";
  number: number;
  url: string;
  draft: boolean;
  message: string;
  verification: { ran: boolean; command?: string; passed?: boolean };
}

export interface OpenPullRequestHooks {
  // Host-side write-ahead audit. False means this tool_use already ran
  // (crash recovery): nothing may be pushed or created again.
  beginAudit(): boolean;
  settleAudit(ok: boolean, detail: string): void;
  // Host composes the final PR body: model text + incident context +
  // verification verbatim + plain-text session reference.
  composeBody(
    verification: VerificationOutcome,
    filesChanged: string[],
  ): string;
}

// The agent knows the repo's toolchain; Nightwatch only enforces that the
// supplied command passes in a fresh run at PR time.
async function runVerification(
  ws: Workspace,
  command: string | null,
  timeoutMs: number,
): Promise<VerificationOutcome> {
  if (ws.options.network === "none") {
    return {
      ran: false,
      reason:
        'the sandbox is networkless (sandboxNetwork "none"), so dependencies cannot be installed to run checks',
    };
  }
  if (command === null) {
    throw new VerificationFailedError(
      "verificationCommand",
      "verificationCommand is required: pass the repository's own check command (e.g. its test script).",
    );
  }
  const result = await ws.exec(command, { timeoutMs });
  if (result.exitCode !== 0) {
    const note =
      result.exitCode === 124
        ? `\n(command timed out after ${Math.round(timeoutMs / 1000)}s)`
        : "";
    throw new VerificationFailedError(command, `${result.output}${note}`);
  }
  return { ran: true, command, output: result.output };
}

// Verifies fresh (the agent may have edited since the last green run), commits,
// pushes, then create-or-updates by branch identity - one PR per session.
export async function openPullRequest(
  ws: Workspace,
  input: {
    title: string;
    verificationCommand: string | null;
    verificationTimeoutMs: number;
  },
  hooks: OpenPullRequestHooks,
): Promise<OpenPullRequestOutcome> {
  const verification = await runVerification(
    ws,
    input.verificationCommand,
    input.verificationTimeoutMs,
  );

  if (!hooks.beginAudit()) {
    throw new Error(
      "This pull request action was already attempted (outcome unknown - it may have run). Check GitHub and the Audit Log before retrying with a fresh call.",
    );
  }

  try {
    if (await isDirty(ws.dir)) {
      await commitAll(ws.dir, input.title, ws.options.commitAuthor);
    }
    const files = await changedFiles(ws.dir);
    const body = hooks.composeBody(verification, files);
    if (await hasUnpushedWork(ws.dir)) {
      await push(ws.dir, ws.branch, await ws.options.authHeader());
    }

    const existing = await ws.options.pullRequests.findOpenByBranch(ws.branch);
    let outcome: OpenPullRequestOutcome;
    if (existing !== null) {
      // The push above already updated the PR's commits; refresh title/body.
      await ws.options.pullRequests.update(existing.number, {
        title: input.title,
        body,
      });
      outcome = {
        action: "updated",
        number: existing.number,
        url: existing.url,
        draft: existing.draft,
        message: `Updated existing PR #${existing.number} with your latest commits.`,
        verification: {
          ran: verification.ran,
          ...(verification.command !== undefined && {
            command: verification.command,
          }),
          ...(verification.ran && { passed: true }),
        },
      };
    } else {
      const created = await ws.options.pullRequests.create({
        title: input.title,
        body,
        draft: true,
      });
      outcome = {
        action: "created",
        number: created.number,
        url: created.url,
        draft: created.draft,
        message: created.draft
          ? `Created draft PR #${created.number}. A human reviews and merges on GitHub.`
          : `Created PR #${created.number} (draft mode is unavailable on this repository's GitHub plan). A human reviews and merges on GitHub.`,
        verification: {
          ran: verification.ran,
          ...(verification.command !== undefined && {
            command: verification.command,
          }),
          ...(verification.ran && { passed: true }),
        },
      };
    }
    hooks.settleAudit(
      true,
      JSON.stringify({
        action: outcome.action,
        number: outcome.number,
        url: outcome.url,
        draft: outcome.draft,
      }),
    );
    return outcome;
  } catch (err) {
    hooks.settleAudit(false, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
