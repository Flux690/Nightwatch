import { logger } from "../logger.js";
import type { GetRecentCommitsInput, CommitInfo } from "@nightwatch/shared";
import type { ToolUse, ToolResult } from "../llm/types.js";

export async function handlePlatformTool(
  tool: ToolUse,
  incidentId: string,
  clarificationsUsed: number,
): Promise<ToolResult> {
  if (tool.name === "request_clarification") {
    if (clarificationsUsed >= 1) {
      return {
        tool_use_id: tool.id,
        content:
          "request_clarification already used once this investigation. Deliver your final_response with the evidence already gathered.",
        is_error: true,
      };
    }
    const question =
      (tool.input["question"] as string | undefined) ?? "(no question)";
    const context = (tool.input["context"] as string | undefined) ?? "";
    logger.info({ incidentId, question }, "clarification requested");
    /* Phase 5: send to Slack and await response on approvalBus with CLARIFICATION_TIMEOUT_MS. */
    return {
      tool_use_id: tool.id,
      content: `Automated mode — no human available to answer "${question}". Context noted: ${context}. Continue with the evidence you have and deliver your final_response as best you can.`,
    };
  }

  if (tool.name === "get_recent_commits") {
    try {
      const commits = await fetchGitHubCommits(
        tool.input as unknown as GetRecentCommitsInput,
      );
      return { tool_use_id: tool.id, content: JSON.stringify(commits) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        tool_use_id: tool.id,
        content: `GitHub fetch failed: ${msg}`,
        is_error: true,
      };
    }
  }

  return {
    tool_use_id: tool.id,
    content: `No handler for platform tool "${tool.name}".`,
    is_error: true,
  };
}

async function fetchGitHubCommits(
  input: GetRecentCommitsInput,
): Promise<{ commits: CommitInfo[] }> {
  const { repoOwner, repoName, branch = "main", limit = 10 } = input;
  const token = process.env["GITHUB_TOKEN"];

  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/commits?sha=${branch}&per_page=${limit}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "nightwatch-api/2",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

  const raw = (await res.json()) as Array<Record<string, unknown>>;
  const commits: CommitInfo[] = raw.map((c) => {
    const commit = c["commit"] as Record<string, unknown>;
    const author = commit["author"] as Record<string, unknown>;
    const sha = String(c["sha"] ?? "");
    return {
      sha,
      shortSha: sha.slice(0, 7),
      message: String(
        (commit["message"] as string | undefined)?.split("\n")[0] ?? "",
      ),
      author: String((author?.["name"] as string | undefined) ?? ""),
      timestamp: String((author?.["date"] as string | undefined) ?? ""),
      filesChanged: [],
      additions: 0,
      deletions: 0,
    };
  });

  return { commits };
}
