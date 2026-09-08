import { z } from "zod";
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

/* Shapes from GitHub's documented payloads. Adding a response field is
   non-breaking by their own policy, so unknown keys pass and a rename fails. */
const REPO_ROW = z.looseObject({
  full_name: z.string(),
  private: z.boolean(),
  pushed_at: z.string().nullish(),
  owner: z.looseObject({ type: z.string() }).nullish(),
});

const PULL_REQUEST = z.looseObject({
  number: z.number(),
  html_url: z.string(),
  draft: z.boolean().nullish(),
});

const REPOSITORY = z.looseObject({ default_branch: z.string() });

const COMMIT_ROW = z.looseObject({
  sha: z.string(),
  commit: z.looseObject({
    message: z.string(),
    author: z.looseObject({ name: z.string(), date: z.string() }).nullish(),
  }),
  parents: z.array(z.unknown()).nullish(),
});

const MERGED_PULL_REQUEST = z.looseObject({
  number: z.number(),
  title: z.string(),
  html_url: z.string(),
  updated_at: z.string().nullish(),
  merged_at: z.string().nullish(),
  merge_commit_sha: z.string().nullish(),
  user: z.looseObject({ login: z.string() }).nullish(),
});

const PR_FILE = z.looseObject({ filename: z.string() });

// The one field name a caller can act on, so a drift says which it was.
function fieldPath(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined || issue.path.length === 0
    ? "the response body"
    : issue.path.join(".");
}

/* Parsed rather than cast: a shape we cannot read is a failure the agent must
   see, never an empty list it would read as "nothing changed". */
function parse<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new GitHubApiError(
    "bad_response",
    0,
    `GitHub answered ${what} in a shape this cannot read: ${fieldPath(parsed.error)} is wrong. Nothing was read, so treat this as unknown rather than as an absence.`,
  );
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
// normalized to ISO so the frontend can compute days-remaining.
function parseExpiryHeader(res: Response): string | null {
  const raw = res.headers.get("github-authentication-token-expiration");
  if (!raw) return null;
  const parsed = new Date(raw.replace(" UTC", "Z").replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// Shared error ladder: 401 and 403-with-SSO are deterministic signals and map
// the same way on every GitHub call; everything else is the caller's business.
/* What a call reaching GitHub outside a tool's own budget may take. The sandbox
   caches a workspace, so its pull-request closures outlive the call that built them. */
export const GITHUB_TIMEOUT_MS = 30_000;

export function githubSignal(): AbortSignal {
  return AbortSignal.timeout(GITHUB_TIMEOUT_MS);
}

async function githubFetch(
  token: string,
  signal: AbortSignal,
  path: string,
  init?: { method: string; body: unknown },
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      signal,
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

// A fine-grained PAT returns only the repos it was granted, so this list is
// the consent the user gave on GitHub's token page.
export async function listRepos(
  token: string,
  signal: AbortSignal,
  page: number,
): Promise<RepoListResult> {
  const res = await githubFetch(
    token,
    signal,
    `/user/repos?per_page=100&page=${page}&sort=pushed`,
  );
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} listing repositories`,
    );
  }
  const body = parse(
    z.array(REPO_ROW),
    await res.json(),
    "listing repositories",
  );
  const repos: GitHubRepoSummary[] = body.map((r) => ({
    fullName: r.full_name,
    private: r.private,
    pushedAt: r.pushed_at ?? null,
    ownerIsOrg: r.owner?.type === "Organization",
  }));
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
  signal: AbortSignal,
  owner: string,
  name: string,
): Promise<ValidatedRepo> {
  const res = await githubFetch(token, signal, `/repos/${owner}/${name}`);
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
export async function ownerIsOrganization(
  owner: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch(`${GITHUB_API}/users/${owner}`, {
      signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "nightwarden",
      },
    });
    if (!res.ok) return false;
    const body = z
      .looseObject({ type: z.string() })
      .safeParse(await res.json());
    return body.success && body.data.type === "Organization";
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

function toPullRequestInfo(pr: z.infer<typeof PULL_REQUEST>): PullRequestInfo {
  return { number: pr.number, url: pr.html_url, draft: pr.draft === true };
}

// One open PR per branch is the idempotency mechanism: the caller looks the
// branch up before creating, so a second call updates instead of duplicating.
export async function findOpenPullRequestByBranch(
  token: string,
  signal: AbortSignal,
  owner: string,
  name: string,
  branch: string,
): Promise<PullRequestInfo | null> {
  const res = await githubFetch(
    token,
    signal,
    `/repos/${owner}/${name}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
  );
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} looking up pull requests`,
    );
  }
  const body = parse(
    z.array(PULL_REQUEST),
    await res.json(),
    "looking up pull requests",
  );
  const pr = body[0];
  return pr === undefined ? null : toPullRequestInfo(pr);
}

export async function defaultBranch(
  token: string,
  signal: AbortSignal,
  owner: string,
  name: string,
): Promise<string> {
  const res = await githubFetch(token, signal, `/repos/${owner}/${name}`);
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} reading the repository`,
    );
  }
  return parse(REPOSITORY, await res.json(), "reading the repository")
    .default_branch;
}

function isDraftUnsupported(status: number, bodyText: string): boolean {
  return status === 422 && /draft pull request/i.test(bodyText);
}

// Not a safety mechanism: where the repo's plan rejects drafts (422 on private
// repos under Free) the PR is created regular and draft:false reflects that.
export async function createPullRequest(
  token: string,
  signal: AbortSignal,
  owner: string,
  name: string,
  req: { title: string; body: string; head: string; draft: boolean },
): Promise<PullRequestInfo> {
  const base = await defaultBranch(token, signal, owner, name);
  const payload = {
    title: req.title,
    body: req.body,
    head: req.head,
    base,
    draft: req.draft,
  };
  let res = await githubFetch(token, signal, `/repos/${owner}/${name}/pulls`, {
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
    res = await githubFetch(token, signal, `/repos/${owner}/${name}/pulls`, {
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
  return toPullRequestInfo(
    parse(PULL_REQUEST, await res.json(), "creating a pull request"),
  );
}

export async function updatePullRequest(
  token: string,
  signal: AbortSignal,
  owner: string,
  name: string,
  prNumber: number,
  patch: { title: string; body: string },
): Promise<void> {
  const res = await githubFetch(
    token,
    signal,
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
  signal: AbortSignal,
  owner: string,
  name: string,
  branch: string,
  since: string,
  until: string,
): Promise<CommitInfo[]> {
  const res = await githubFetch(
    token,
    signal,
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
  const body = parse(z.array(COMMIT_ROW), await res.json(), "listing commits");
  return body.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    author: c.commit.author?.name ?? "",
    committedAt: c.commit.author?.date ?? "",
    parentCount: c.parents?.length ?? 0,
  }));
}

interface MergedPullRequestInfo {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  url: string;
  mergeCommitSha: string;
}

// Merging updates a PR, so once a row's updated_at precedes the window there
// can be no later in-window merge and the scan stops.
export async function listMergedPullRequests(
  token: string,
  signal: AbortSignal,
  owner: string,
  name: string,
  branch: string,
  since: string,
  until: string,
): Promise<MergedPullRequestInfo[]> {
  const res = await githubFetch(
    token,
    signal,
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
  const body = parse(
    z.array(MERGED_PULL_REQUEST),
    await res.json(),
    "listing pull requests",
  );
  const merged: MergedPullRequestInfo[] = [];
  for (const pr of body) {
    const updatedAt =
      pr.updated_at === undefined || pr.updated_at === null
        ? NaN
        : Date.parse(pr.updated_at);
    if (!Number.isNaN(updatedAt) && updatedAt < sinceMs) break;
    if (pr.merged_at === undefined || pr.merged_at === null) continue;
    const mergedMs = Date.parse(pr.merged_at);
    if (Number.isNaN(mergedMs) || mergedMs < sinceMs || mergedMs > untilMs) {
      continue;
    }
    merged.push({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? "",
      mergedAt: pr.merged_at,
      url: pr.html_url,
      mergeCommitSha: pr.merge_commit_sha ?? "",
    });
  }
  return merged;
}

export async function listPullRequestFiles(
  token: string,
  signal: AbortSignal,
  owner: string,
  name: string,
  prNumber: number,
): Promise<string[]> {
  const res = await githubFetch(
    token,
    signal,
    `/repos/${owner}/${name}/pulls/${prNumber}/files?per_page=100`,
  );
  if (!res.ok) {
    throw new GitHubApiError(
      "network",
      res.status,
      `GitHub returned ${res.status} listing files for pull request #${prNumber}`,
    );
  }
  const body = parse(
    z.array(PR_FILE),
    await res.json(),
    `listing files for pull request #${prNumber}`,
  );
  return body.map((f) => f.filename);
}
