import { decrypt } from "../../config/crypto.js";
import { getGitHubIntegration } from "../../db/integrations.js";
import { alertAnchorFor } from "./alert-anchor.js";
import {
  defaultBranch,
  listCommits,
  listMergedPullRequests,
  listPullRequestFiles,
  GitHubApiError,
} from "../../integrations/github.js";
import type { Tool, ToolExecuteResult } from "./types.js";

// API-local by design: these shapes never cross the runner wire, so they live
// with the tool rather than in @nightwatch/shared.
export interface RecentPullRequest {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  url: string;
  files?: string[];
  filesOmitted?: boolean;
}

export interface RecentCommit {
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
  note?: string;
}

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 168;
// Each file list is one extra GitHub call, so a bulk-merge window cannot fan
// out unbounded; PRs beyond the cap are still listed, just without files.
const FILES_FETCH_CAP = 15;

function windowHoursFrom(input: Record<string, unknown>): number {
  const raw = input["windowHours"];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_WINDOW_HOURS;
  }
  return Math.min(raw, MAX_WINDOW_HOURS);
}

function isPermissionStatus(err: unknown): boolean {
  return (
    err instanceof GitHubApiError && (err.status === 403 || err.status === 404)
  );
}

async function pullRequestsWithFiles(
  token: string,
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
        note: "Merged pull requests are unavailable: the GitHub token lacks Pull requests read access. Results are commits-only; the operator can widen the token's permissions on the Integrations page.",
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
          files: await listPullRequestFiles(token, owner, name, pr.number),
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
  {
    schema: {
      name: "GetRecentChanges",
      description:
        "List merged pull requests and mainline commits on the connected repository's default branch in a window ending at the alert (or now for chat sessions). This is evidence of what MERGED, not what deployed: correlate with the running image tag or restart times before naming a change as the cause. Use it early - missing change context is the top source of wrong root causes.",
      input_schema: {
        type: "object",
        properties: {
          windowHours: {
            type: "number",
            description:
              "Lookback window in hours before the alert (default 24, max 168).",
          },
        },
        required: [],
      },
    },
    access: "read",
    timeoutMs: 60_000,
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const integration = getGitHubIntegration();
      if (integration === null) {
        return {
          content:
            "GitHub integration is not configured. The operator can connect a repository from the Integrations page. Continue without recent-change context.",
          is_error: true,
        };
      }
      const { repoOwner, repoName } = integration;

      // The window ends at the alert: a change merged after it fired cannot have caused it.
      const windowEnd = alertAnchorFor(ctx.sessionId);
      const windowStart = new Date(
        windowEnd.getTime() - windowHoursFrom(input) * 3_600_000,
      );
      const since = windowStart.toISOString();
      const until = windowEnd.toISOString();

      // Like the repo tools, this never throws into the loop: every failure
      // becomes a corrective result the agent can act on.
      try {
        const token = decrypt(integration.tokenEncrypted);
        const branch = await defaultBranch(token, repoOwner, repoName);
        const [{ pullRequests, mergeShas, note }, allCommits] =
          await Promise.all([
            pullRequestsWithFiles(
              token,
              repoOwner,
              repoName,
              branch,
              since,
              until,
            ),
            listCommits(token, repoOwner, repoName, branch, since, until),
          ]);

        // Drop PR merge commits from the commit list so the two lists do not
        // double-report; multi-parent commits are merges by definition, and
        // squash merges match the PR's merge_commit_sha.
        const commits: RecentCommit[] = allCommits
          .filter((c) => c.parentCount <= 1 && !mergeShas.has(c.sha))
          .map(({ sha, message, author, committedAt }) => ({
            sha,
            message,
            author,
            committedAt,
          }));

        const result: GetRecentChangesResult = {
          branch,
          windowStart: since,
          windowEnd: until,
          pullRequests,
          commits,
          ...(note !== undefined && { note }),
        };
        return { content: result };
      } catch (err) {
        const detail =
          err instanceof GitHubApiError
            ? `GitHub request failed: ${err.message}. If the token is invalid or expired the operator must reconnect on the Integrations page.`
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          content: `${detail} Continue the investigation without recent-change context.`,
          is_error: true,
        };
      }
    },
  },
];
