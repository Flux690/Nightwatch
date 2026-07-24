import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedAlert } from "@nightwarden/shared";
import { useTempDb } from "./temp-db.js";
import { encrypt } from "../config/crypto.js";
import { saveGitHubIntegration } from "../db/integrations.js";
import { createSession } from "../db/sessions.js";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import type { GetRecentChangesResult } from "../agent/tools/github.js";
import type { Tool, ToolExecuteContext } from "../agent/tools/types.js";

const FIRED_AT = "2026-07-16T12:00:00.000Z";
const WINDOW_START_24H = "2026-07-15T12:00:00.000Z";

const ALERT: NormalizedAlert = {
  sourceAlertId: "alert-1",
  labels: {},
  targetIdentifier: { provider: "docker", project: "shop", service: "api" },
  alertType: "OOMKill",
  severity: "critical",
  firedAt: FIRED_AT,
  rawPayload: {},
};

interface GitHubMock {
  requests: string[];
  pulls: Array<Record<string, unknown>>;
  commits: Array<Record<string, unknown>>;
  filesByPr: Record<number, string[]>;
  pullsStatus: number;
  commitsStatus: number;
  repoStatus: number;
}

function makeMock(): GitHubMock {
  return {
    requests: [],
    pulls: [],
    commits: [],
    filesByPr: {},
    pullsStatus: 200,
    commitsStatus: 200,
    repoStatus: 200,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Routes the four GitHub endpoints the tool touches; anything else is a test
// bug and fails loudly.
function installFetchMock(mock: GitHubMock): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<Response> => {
      const url = String(input);
      mock.requests.push(url);
      const filesMatch = url.match(/\/pulls\/(\d+)\/files/);
      if (filesMatch !== null) {
        return json(
          (mock.filesByPr[Number(filesMatch[1])] ?? []).map((filename) => ({
            filename,
          })),
        );
      }
      if (url.includes("/commits?")) {
        if (mock.commitsStatus !== 200) return json([], mock.commitsStatus);
        return json(mock.commits);
      }
      if (url.includes("/pulls?")) {
        if (mock.pullsStatus !== 200) return json([], mock.pullsStatus);
        return json(mock.pulls);
      }
      if (url.endsWith("/repos/acme/shop")) {
        if (mock.repoStatus !== 200) return json({}, mock.repoStatus);
        return json({ default_branch: "main" });
      }
      throw new Error(`Unexpected GitHub request in test: ${url}`);
    }),
  );
}

function mergedPr(
  number: number,
  mergedAt: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    title: `PR ${number}`,
    user: { login: "dev-a" },
    merged_at: mergedAt,
    updated_at: mergedAt,
    html_url: `https://github.com/acme/shop/pull/${number}`,
    merge_commit_sha: `merge-sha-${number}`,
    ...overrides,
  };
}

function commit(
  sha: string,
  message: string,
  date: string,
  parentCount = 1,
): Record<string, unknown> {
  return {
    sha,
    commit: { message, author: { name: "dev-a", date } },
    parents: Array.from({ length: parentCount }, (_, i) => ({
      sha: `p-${sha}-${i}`,
    })),
  };
}

describe("GetRecentChanges through the tool dispatch", () => {
  let cleanupDb: () => void;
  let tool: Tool;
  let sessionSeq = 0;

  function mintSession(alert: NormalizedAlert | null): ToolExecuteContext {
    sessionSeq++;
    const sessionId = `gh-changes-${sessionSeq}`;
    createSession(
      { sessionId, title: "test", createdAt: new Date().toISOString() },
      alert,
    );
    return { toolTimeoutMs: 60_000, sessionId, toolUseId: `tu-${sessionSeq}` };
  }

  function connectGitHub(): void {
    saveGitHubIntegration({
      tokenEncrypted: encrypt("ghp_test_token"),
      repoOwner: "acme",
      repoName: "shop",
      tokenExpiresAt: null,
    });
  }

  beforeEach(() => {
    cleanupDb = useTempDb();
    const found = findTool("GetRecentChanges");
    if (found === undefined) throw new Error("GetRecentChanges not registered");
    tool = found;
  });

  afterEach(() => {
    cleanupDb();
    vi.unstubAllGlobals();
  });

  it("anchors the window on the alert's firedAt and reports the merged PR with link and files", async () => {
    connectGitHub();
    const mock = makeMock();
    mock.pulls = [
      mergedPr(42, "2026-07-16T11:30:00Z"),
      // Closed but never merged: excluded.
      mergedPr(41, "2026-07-16T11:00:00Z", { merged_at: null }),
      // Merged before the window: excluded.
      mergedPr(7, "2026-07-14T10:00:00Z"),
    ];
    mock.commits = [commit("c1", "fix: shrink pool", "2026-07-16T11:31:00Z")];
    mock.filesByPr = { 42: ["src/redis.ts", "src/config.ts"] };
    installFetchMock(mock);

    const outcome = await executeTool(tool, {}, mintSession(ALERT));

    expect(outcome.is_error).toBeUndefined();
    const result = outcome.content as GetRecentChangesResult;
    expect(result.branch).toBe("main");
    expect(result.windowStart).toBe(WINDOW_START_24H);
    expect(result.windowEnd).toBe(FIRED_AT);

    const commitsUrl = mock.requests.find((u) => u.includes("/commits?"));
    const params = new URL(commitsUrl!).searchParams;
    expect(params.get("sha")).toBe("main");
    expect(params.get("since")).toBe(WINDOW_START_24H);
    expect(params.get("until")).toBe(FIRED_AT);

    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]).toMatchObject({
      number: 42,
      url: "https://github.com/acme/shop/pull/42",
      files: ["src/redis.ts", "src/config.ts"],
    });
  });

  it("a chat session with no alert anchors the window to now", async () => {
    connectGitHub();
    const mock = makeMock();
    installFetchMock(mock);

    const before = Date.now();
    const outcome = await executeTool(tool, {}, mintSession(null));
    const after = Date.now();

    const result = outcome.content as GetRecentChangesResult;
    const end = Date.parse(result.windowEnd);
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(after);
  });

  it("caps the windowHours input at 7 days", async () => {
    connectGitHub();
    const mock = makeMock();
    installFetchMock(mock);

    await executeTool(tool, { windowHours: 10_000 }, mintSession(ALERT));

    const commitsUrl = mock.requests.find((u) => u.includes("/commits?"));
    const since = new URL(commitsUrl!).searchParams.get("since");
    const expectedStart = Date.parse(FIRED_AT) - 168 * 3_600_000;
    expect(Date.parse(since!)).toBe(expectedStart);
  });

  it("excludes merge commits and squash-merge commits from the direct-commit list", async () => {
    connectGitHub();
    const mock = makeMock();
    mock.pulls = [mergedPr(42, "2026-07-16T11:30:00Z")];
    mock.commits = [
      commit("plain-1", "fix: direct push", "2026-07-16T11:45:00Z"),
      // Two parents: a merge commit by definition.
      commit("m-1", "Merge pull request #42", "2026-07-16T11:30:00Z", 2),
      // Single parent but matches the PR's merge_commit_sha: a squash merge.
      commit("merge-sha-42", "PR 42 (#42)", "2026-07-16T11:30:00Z"),
    ];
    installFetchMock(mock);

    const outcome = await executeTool(tool, {}, mintSession(ALERT));

    const result = outcome.content as GetRecentChangesResult;
    expect(result.commits.map((c) => c.sha)).toEqual(["plain-1"]);
  });

  it("fetches files for at most 15 PRs and marks the rest filesOmitted", async () => {
    connectGitHub();
    const mock = makeMock();
    mock.pulls = Array.from({ length: 16 }, (_, i) =>
      mergedPr(i + 1, "2026-07-16T11:30:00Z"),
    );
    for (let n = 1; n <= 16; n++) mock.filesByPr[n] = [`file-${n}.ts`];
    installFetchMock(mock);

    const outcome = await executeTool(tool, {}, mintSession(ALERT));

    const result = outcome.content as GetRecentChangesResult;
    expect(result.pullRequests).toHaveLength(16);
    const fileRequests = mock.requests.filter((u) => u.includes("/files"));
    expect(fileRequests).toHaveLength(15);
    const omitted = result.pullRequests.filter((p) => p.filesOmitted === true);
    expect(omitted).toHaveLength(1);
    expect(omitted[0]?.files).toBeUndefined();
  });

  it("degrades to commits-only with a note when the token cannot list pull requests", async () => {
    connectGitHub();
    const mock = makeMock();
    mock.pullsStatus = 403;
    mock.commits = [commit("c1", "fix: something", "2026-07-16T11:31:00Z")];
    installFetchMock(mock);

    const outcome = await executeTool(tool, {}, mintSession(ALERT));

    expect(outcome.is_error).toBeUndefined();
    const result = outcome.content as GetRecentChangesResult;
    expect(result.pullRequests).toEqual([]);
    expect(result.commits).toHaveLength(1);
    expect(result.note).toContain("Pull requests read access");
  });

  it("treats an empty repository (409 on commits) as no commits, not a failure", async () => {
    connectGitHub();
    const mock = makeMock();
    mock.commitsStatus = 409;
    installFetchMock(mock);

    const outcome = await executeTool(tool, {}, mintSession(ALERT));

    expect(outcome.is_error).toBeUndefined();
    const result = outcome.content as GetRecentChangesResult;
    expect(result.commits).toEqual([]);
  });

  it("a GitHub failure returns a corrective error result, never a thrown error", async () => {
    connectGitHub();
    const mock = makeMock();
    mock.repoStatus = 500;
    installFetchMock(mock);

    const outcome = await executeTool(tool, {}, mintSession(ALERT));

    expect(outcome.is_error).toBe(true);
    expect(outcome.content).toContain(
      "Continue the investigation without recent-change context",
    );
  });

  it("tells the agent to continue when no GitHub integration is configured", async () => {
    const mock = makeMock();
    installFetchMock(mock);

    const outcome = await executeTool(tool, {}, mintSession(ALERT));

    expect(outcome.is_error).toBe(true);
    expect(outcome.content).toContain("not configured");
    expect(mock.requests).toEqual([]);
  });
});
