import type {
  GitHubErrorCode,
  GitHubRepoPage,
  GitHubRepoSummary,
} from "@nightwarden/shared";

const GITHUB_API = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "nightwarden",
  };
}

// The header is "YYYY-MM-DD HH:MM:SS UTC", absent for non-expiring tokens;
// normalized to ISO so the console can compute days-remaining.
function parseExpiryHeader(res: Response): string | null {
  const raw = res.headers.get("github-authentication-token-expiration");
  if (!raw) return null;
  const parsed = new Date(raw.replace(" UTC", "Z").replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Shared error ladder: 401 and 403-with-SSO are deterministic signals and map
// the same way on every GitHub call; everything else is the caller's business.
async function githubFetch(
  token: string,
  path: string,
  init?: { method: string; body: unknown },
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      headers:
        init === undefined
          ? baseHeaders(token)
          : { ...baseHeaders(token), "Content-Type": "application/json" },
      ...(init !== undefined && {
        method: init.method,
        body: JSON.stringify(init.body),
      }),
    });
  } catch {
    throw new GitHubApiError("network", 0, "Could not reach GitHub");
  }
  if (res.status === 401) {
    throw new GitHubApiError(
      "invalid_token",
      401,
      "Token invalid, revoked, or expired",
    );
  }
  if (res.status === 403 && res.headers.get("x-github-sso") !== null) {
    throw new GitHubApiError(
      "sso_required",
      403,
      "Token must be authorized for SSO on GitHub",
    );
  }
  return res;
}

interface RepoListResult extends GitHubRepoPage {
  expiresAt: string | null;
}

// A fine-grained PAT returns only the repos it was granted, so this list IS the
// consent the user gave on GitHub's token page; per_page 100 + pushed-sort also
// absorbs the classic-PAT escape hatch (everything readable).
export async function listRepos(
  token: string,
  page: number,
): Promise<RepoListResult> {
  const res = await githubFetch(
    token,
    `/user/repos?per_page=100&page=${page}&sort=pushed`,
  );
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} listing repositories`,
    );
  }
  // Shape is guaranteed by GitHub's documented /user/repos payload; fields are
  // individually narrowed below, so a drifted payload degrades, never crashes.
  const body = (await res.json()) as Array<Record<string, unknown>>;
  const repos: GitHubRepoSummary[] = body.map((r) => {
    const owner = r["owner"] as Record<string, unknown> | undefined;
    return {
      fullName: typeof r["full_name"] === "string" ? r["full_name"] : "",
      private: r["private"] === true,
      pushedAt: typeof r["pushed_at"] === "string" ? r["pushed_at"] : null,
      ownerIsOrg: owner?.["type"] === "Organization",
    };
  });
  const hasMore = /\brel="next"/.test(res.headers.get("link") ?? "");
  return { repos, hasMore, expiresAt: parseExpiryHeader(res) };
}

interface ValidatedRepo {
  owner: string;
  name: string;
  expiresAt: string | null;
}

// GitHub deliberately 404s existence, visibility, and permission failures
// alike; the route layer adds the org-approval hint when the owner is an org.
export async function validateRepoAccess(
  token: string,
  owner: string,
  name: string,
): Promise<ValidatedRepo> {
  const res = await githubFetch(token, `/repos/${owner}/${name}`);
  if (res.status === 404) {
    throw new GitHubApiError(
      "repo_not_found",
      404,
      `GitHub returned 404 for ${owner}/${name}`,
    );
  }
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} for ${owner}/${name}`,
    );
  }
  return { owner, name, expiresAt: parseExpiryHeader(res) };
}

// Public check, no permissions needed: an org owner makes "pending org-admin
// approval" a plausible cause of a 404; a user owner rules it out.
export async function ownerIsOrganization(owner: string): Promise<boolean> {
  try {
    const res = await fetch(`${GITHUB_API}/users/${owner}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "nightwarden",
      },
    });
    if (!res.ok) return false;
    // Narrowed to the single field we read; see listRepos for the same policy.
    const body = (await res.json()) as Record<string, unknown>;
    return body["type"] === "Organization";
  } catch {
    return false;
  }
}

// Built here so token-formatting knowledge never enters the sandbox module;
// it receives this value opaque and redacts it from all output.
export function buildAuthHeader(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

interface PullRequestInfo {
  number: number;
  url: string;
  draft: boolean;
}

function toPullRequestInfo(pr: Record<string, unknown>): PullRequestInfo {
  return {
    number: typeof pr["number"] === "number" ? pr["number"] : 0,
    url: typeof pr["html_url"] === "string" ? pr["html_url"] : "",
    draft: pr["draft"] === true,
  };
}

// One open PR per branch is the idempotency mechanism: the caller looks the
// branch up before creating, so a second call updates instead of duplicating.
export async function findOpenPullRequestByBranch(
  token: string,
  owner: string,
  name: string,
  branch: string,
): Promise<PullRequestInfo | null> {
  const res = await githubFetch(
    token,
    `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} looking up pull requests`,
    );
  }
  // Narrowed field-by-field below, same policy as listRepos.
  const body = (await res.json()) as Array<Record<string, unknown>>;
  const pr = body[0];
  return pr === undefined ? null : toPullRequestInfo(pr);
}

export async function defaultBranch(
  token: string,
  owner: string,
  name: string,
): Promise<string> {
  const res = await githubFetch(token, `/repos/${owner}/${name}`);
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} reading the repository`,
    );
  }
  // Narrowed to the single field we read.
  const body = (await res.json()) as Record<string, unknown>;
  return typeof body["default_branch"] === "string"
    ? body["default_branch"]
    : "main";
}

function isDraftUnsupported(status: number, bodyText: string): boolean {
  return status === 422 && /draft pull request/i.test(bodyText);
}

// Not a safety mechanism: where the repo's plan rejects drafts (422 on private
// repos under Free) the PR is created regular and draft:false reflects that.
export async function createPullRequest(
  token: string,
  owner: string,
  name: string,
  req: { title: string; body: string; head: string; draft: boolean },
): Promise<PullRequestInfo> {
  const base = await defaultBranch(token, owner, name);
  const payload = {
    title: req.title,
    body: req.body,
    head: req.head,
    base,
    draft: req.draft,
  };
  let res = await githubFetch(token, `/repos/${owner}/${name}/pulls`, {
    method: "POST",
    body: payload,
  });
  if (!res.ok && req.draft) {
    const text = await res.text();
    if (!isDraftUnsupported(res.status, text)) {
      throw new GitHubApiError(
        "network",
        res.status,
        `GitHub refused the pull request: ${text.slice(0, 300)}`,
      );
    }
    res = await githubFetch(token, `/repos/${owner}/${name}/pulls`, {
      method: "POST",
      body: { ...payload, draft: false },
    });
  }
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub refused the pull request: ${(await res.text()).slice(0, 300)}`,
    );
  }
  // Narrowed field-by-field in toPullRequestInfo.
  const body = (await res.json()) as Record<string, unknown>;
  return toPullRequestInfo(body);
}

export async function updatePullRequest(
  token: string,
  owner: string,
  name: string,
  prNumber: number,
  patch: { title: string; body: string },
): Promise<void> {
  const res = await githubFetch(
    token,
    `/repos/${owner}/${name}/pulls/${prNumber}`,
    { method: "PATCH", body: patch },
  );
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} updating pull request #${prNumber}`,
    );
  }
}

interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  committedAt: string;
  parentCount: number;
}

// One page of 100, newest first (the API's default order); a window busier
// than that is beyond what change correlation needs, so no pagination.
export async function listCommits(
  token: string,
  owner: string,
  name: string,
  branch: string,
  since: string,
  until: string,
): Promise<CommitInfo[]> {
  const res = await githubFetch(
    token,
    `/repos/${owner}/${name}/commits?sha=${encodeURIComponent(branch)}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=100`,
  );
  // An empty repository 409s on the commits listing; that is "no commits",
  // not a failure.
  if (res.status === 409) return [];
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} listing commits`,
    );
  }
  // Narrowed field-by-field, same policy as listRepos.
  const body = (await res.json()) as Array<Record<string, unknown>>;
  return body.map((c) => {
    const commit = c["commit"] as Record<string, unknown> | undefined;
    const commitAuthor = commit?.["author"] as
      Record<string, unknown> | undefined;
    const parents = c["parents"];
    return {
      sha: typeof c["sha"] === "string" ? c["sha"] : "",
      message: typeof commit?.["message"] === "string" ? commit["message"] : "",
      author:
        typeof commitAuthor?.["name"] === "string" ? commitAuthor["name"] : "",
      committedAt:
        typeof commitAuthor?.["date"] === "string" ? commitAuthor["date"] : "",
      parentCount: Array.isArray(parents) ? parents.length : 0,
    };
  });
}

interface MergedPullRequestInfo {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  url: string;
  mergeCommitSha: string;
}

// state=closed sorted by updated desc: merging updates a PR, so once a row's
// updated_at precedes the window there can be no later in-window merge and the
// scan stops - one page usually suffices without a merged-state filter upstream.
export async function listMergedPullRequests(
  token: string,
  owner: string,
  name: string,
  branch: string,
  since: string,
  until: string,
): Promise<MergedPullRequestInfo[]> {
  const res = await githubFetch(
    token,
    `/repos/${owner}/${name}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=100`,
  );
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} listing pull requests`,
    );
  }
  // Epoch comparisons, never string ones: GitHub omits milliseconds while
  // toISOString keeps them, so lexicographic order lies at window boundaries.
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  // Narrowed field-by-field, same policy as listRepos.
  const body = (await res.json()) as Array<Record<string, unknown>>;
  const merged: MergedPullRequestInfo[] = [];
  for (const pr of body) {
    const updatedAt =
      typeof pr["updated_at"] === "string" ? Date.parse(pr["updated_at"]) : NaN;
    if (!Number.isNaN(updatedAt) && updatedAt < sinceMs) break;
    const mergedAt = pr["merged_at"];
    if (typeof mergedAt !== "string") continue;
    const mergedMs = Date.parse(mergedAt);
    if (Number.isNaN(mergedMs) || mergedMs < sinceMs || mergedMs > untilMs) {
      continue;
    }
    const user = pr["user"] as Record<string, unknown> | undefined;
    merged.push({
      number: typeof pr["number"] === "number" ? pr["number"] : 0,
      title: typeof pr["title"] === "string" ? pr["title"] : "",
      author: typeof user?.["login"] === "string" ? user["login"] : "",
      mergedAt,
      url: typeof pr["html_url"] === "string" ? pr["html_url"] : "",
      mergeCommitSha:
        typeof pr["merge_commit_sha"] === "string"
          ? pr["merge_commit_sha"]
          : "",
    });
  }
  return merged;
}

export async function listPullRequestFiles(
  token: string,
  owner: string,
  name: string,
  prNumber: number,
): Promise<string[]> {
  const res = await githubFetch(
    token,
    `/repos/${owner}/${name}/pulls/${prNumber}/files?per_page=100`,
  );
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} listing files for pull request #${prNumber}`,
    );
  }
  // Narrowed field-by-field, same policy as listRepos.
  const body = (await res.json()) as Array<Record<string, unknown>>;
  return body.flatMap((f) =>
    typeof f["filename"] === "string" ? [f["filename"]] : [],
  );
}
