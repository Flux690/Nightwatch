import {
  changedFiles,
  commitAll,
  commitsAgainstBase,
  hasUnpushedWork,
  isDirty,
  push,
} from "../git.js";
import type { Workspace } from "../workspace.js";

export type OpenPullRequestOutcome =
  | {
      action: "created" | "updated";
      number: number;
      url: string;
      draft: boolean;
      message: string;
    }
  // No commits between the branch and its base. GitHub answers this with a bare
  // 422 that reads as a broken token, so it is answered here instead.
  | { action: "nothing_to_propose"; message: string };

export interface OpenPullRequestHooks {
  // Host composes the final PR body: model text + incident context +
  // plain-text session reference.
  composeBody(filesChanged: string[]): string;
}

/* Nothing gates creation: the PR is a draft proposal, the repo's own CI and
   the human merge are the verification layers. Commits, pushes, then
   create-or-updates by branch identity - one PR per session, which is also what
   makes a retry after a crash update the proposal rather than open a second one. */
export async function openPullRequest(
  ws: Workspace,
  input: { title: string },
  hooks: OpenPullRequestHooks,
): Promise<OpenPullRequestOutcome> {
  if (await isDirty(ws.dir)) {
    await commitAll(ws.dir, input.title, ws.options.commitAuthor);
  }
  if ((await commitsAgainstBase(ws.dir)) === 0) {
    return {
      action: "nothing_to_propose",
      message:
        "There is nothing to propose: this branch has no commits against the base branch. Make the change with Edit or Write first, then call OpenPullRequest.",
    };
  }
  const files = await changedFiles(ws.dir);
  const body = hooks.composeBody(files);
  if (await hasUnpushedWork(ws.dir)) {
    await push(ws.dir, ws.branch, await ws.options.authHeader());
  }

  const existing = await ws.options.pullRequests.findOpenByBranch(ws.branch);
  if (existing !== null) {
    // The push above already updated the PR's commits; refresh title/body.
    await ws.options.pullRequests.update(existing.number, {
      title: input.title,
      body,
    });
    return {
      action: "updated",
      number: existing.number,
      url: existing.url,
      draft: existing.draft,
      message: `Updated existing PR #${existing.number} with your latest commits.`,
    };
  }
  const created = await ws.options.pullRequests.create({
    title: input.title,
    body,
    draft: true,
  });
  return {
    action: "created",
    number: created.number,
    url: created.url,
    draft: created.draft,
    message: created.draft
      ? `Created draft PR #${created.number}. A human reviews and merges on GitHub.`
      : `Created PR #${created.number} (draft mode is unavailable on this repository's GitHub plan). A human reviews and merges on GitHub.`,
  };
}
