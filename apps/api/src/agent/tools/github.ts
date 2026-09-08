import { z } from "zod";
import { getGitHubIntegration } from "../../integrations/store.js";
import { alertAnchorFor } from "./alert-anchor.js";
import { ITEM_BUDGET_CHARS, fitWithinBudget } from "./result-budget.js";
import {
  defaultBranch,
  listCommits,
  listMergedPullRequests,
  listPullRequestFiles,
  GitHubApiError,
} from "../../integrations/github.js";
import { apiTool } from "./schema.js";
import type { Tool, ToolExecuteResult } from "./types.js";

// API-local by design: these shapes never cross the runner wire, so they live
// with the tool rather than in @nightwarden/shared.
interface RecentPullRequest {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  url: string;
  files?: string[];
  filesOmitted?: boolean;
}

interface RecentCommit {
  sha: string;
  message: string;
  author: string;
  committedAt: string;
}

export interface GetRecentChangesResult {
  branch: string;
  windowStart: string;
  windowEnd: string;
  pullRequests: RecentPullRequest[];
  commits: RecentCommit[];
  // Merged in the window but past the size budget, so this is not the whole
  // history of it. Absent when everything found is here.
  changesOmitted?: number;
  note?: string;
}

const MAX_WINDOW_HOURS = 168;
// Each file list is one extra GitHub call, so a bulk-merge window cannot fan
// out unbounded; PRs beyond the cap are still listed, just without files.
const FILES_FETCH_CAP = 15;

const RECENT_CHANGES_INPUT = z.object({
  windowHours: z
    .number()
    .int()
    .min(1)
    .max(MAX_WINDOW_HOURS)
    .default(24)
    .meta({
      description: `How many hours before the alert to look back. A whole number from 1 to ${MAX_WINDOW_HOURS}, which is one week, defaulting to 24.`,
    }),
});

function isPermissionStatus(err: unknown): boolean {
  return (
    err instanceof GitHubApiError && (err.status === 403 || err.status === 404)
  );
}

// The sentence follows the same code the class does, so what the model is told
// and what the user sees can never point at different causes.
export function gitHubErrorDetail(err: GitHubApiError): string {
  switch (err.code) {
    case "invalid_token":
      return `GitHub rejected the token. ${err.message} The user must reconnect the repository on the Integrations page.`;
    case "sso_required":
      return `GitHub requires SSO authorization for this token. ${err.message} The user must authorize it on GitHub, then retry.`;
    case "repo_not_found":
      return `GitHub has no such repository, or this token cannot see it. ${err.message}`;
    case "network":
      if (err.status === 403 || err.status === 404) {
        return `GitHub would not serve this. ${err.message} The token authenticated, so this is its repository permissions rather than the credential.`;
      }
      return `GitHub could not serve the request. ${err.message} The token authenticated; this is not a credentials problem.`;
    case "bad_response":
      return err.message;
  }
}

async function pullRequestsWithFiles(
  token: string,
  signal: AbortSignal,
  owner: string,
  name: string,
  branch: string,
  since: string,
  until: string,
): Promise<{
  pullRequests: RecentPullRequest[];
  mergeShas: Set<string>;
  note?: string;
}> {
  let merged;
  try {
    merged = await listMergedPullRequests(
      token,
      signal,
      owner,
      name,
      branch,
      since,
      until,
    );
  } catch (err) {
    // A fine-grained PAT scoped for cloning only may lack Pull-requests read;
    // commits still answer "what changed", so degrade instead of failing.
    if (isPermissionStatus(err)) {
      return {
        pullRequests: [],
        mergeShas: new Set(),
        note: "Merged pull requests are unavailable: the GitHub token lacks Pull requests read access. Results are commits-only; the user can widen the token's permissions on the Integrations page.",
      };
    }
    throw err;
  }

  const pullRequests: RecentPullRequest[] = await Promise.all(
    merged.map(async (pr, index): Promise<RecentPullRequest> => {
      const base: RecentPullRequest = {
        number: pr.number,
        title: pr.title,
        author: pr.author,
        mergedAt: pr.mergedAt,
        url: pr.url,
      };
      if (index >= FILES_FETCH_CAP) return { ...base, filesOmitted: true };
      try {
        return {
          ...base,
          files: await listPullRequestFiles(
            token,
            signal,
            owner,
            name,
            pr.number,
          ),
        };
      } catch {
        return { ...base, filesOmitted: true };
      }
    }),
  );
  return {
    pullRequests,
    mergeShas: new Set(merged.map((pr) => pr.mergeCommitSha)),
  };
}

export const GITHUB_TOOLS: Tool[] = [
  apiTool({
    name: "GetRecentChanges",
    description:
      "List the pull requests merged and the commits landed on the connected repository's default branch in the window ending when the alert fired, or ending now if no alert started this session. Call this early, because not knowing what changed is the most common reason an investigation reaches the wrong conclusion. Note carefully that this tells you what was merged, not what was deployed. Before you name a change as the cause, confirm it actually reached the running system by checking the running image tag or when the service last restarted.",
    input: RECENT_CHANGES_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "change",
    timeoutMs: 60_000,
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const integration = await getGitHubIntegration();
      if (integration === null) {
        return {
          content:
            "GitHub integration is not configured. The user can connect a repository from the Integrations page. Continue without recent-change context.",
          isError: true,
        };
      }
      const { repoOwner, repoName } = integration;

      // The window ends at the alert: a change merged after it fired cannot have caused it.
      const windowEnd = await alertAnchorFor(ctx.sessionId);
      const windowStart = new Date(
        windowEnd.getTime() - input.windowHours * 3_600_000,
      );
      const since = windowStart.toISOString();
      const until = windowEnd.toISOString();

      // Like the repo tools, this never throws into the loop: every failure
      // becomes a corrective result the agent can act on.
      try {
        const token = integration.token;
        const branch = await defaultBranch(
          token,
          ctx.signal,
          repoOwner,
          repoName,
        );
        const [{ pullRequests, mergeShas, note }, allCommits] =
          await Promise.all([
            pullRequestsWithFiles(
              token,
              ctx.signal,
              repoOwner,
              repoName,
              branch,
              since,
              until,
            ),
            listCommits(
              token,
              ctx.signal,
              repoOwner,
              repoName,
              branch,
              since,
              until,
            ),
          ]);

        // Drop merge commits so the two lists do not double-report: multi-parent
        // ones are merges, and a squash merge matches the PR's merge_commit_sha.
        const commits: RecentCommit[] = allCommits
          .filter((c) => c.parentCount <= 1 && !mergeShas.has(c.sha))
          .map(({ sha, message, author, committedAt }) => ({
            sha,
            message,
            author,
            committedAt,
          }));

        // Pull requests are named first because they carry the file lists a
        // change search is looking for; loose commits fill what budget is left.
        const fitPrs = fitWithinBudget(pullRequests);
        const fitCommits = fitWithinBudget(
          commits,
          ITEM_BUDGET_CHARS - fitPrs.spent,
        );
        const changesOmitted = fitPrs.dropped + fitCommits.dropped;
        const result: GetRecentChangesResult = {
          branch,
          windowStart: since,
          windowEnd: until,
          pullRequests: fitPrs.kept,
          commits: fitCommits.kept,
          ...(changesOmitted > 0 && { changesOmitted }),
          ...(note !== undefined && { note }),
        };
        return { content: result };
      } catch (err) {
        const detail =
          err instanceof GitHubApiError
            ? gitHubErrorDetail(err)
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          content: `${detail} Continue the investigation without recent-change context.`,
          isError: true,
        };
      }
    },
  }),
];
