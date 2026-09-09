import { z } from "zod";
import { proxyDir, workspacesDir } from "../../paths.js";
import { loadConfig } from "../../config/store.js";
import { getGitHubIntegration } from "../../integrations/store.js";
import { getSession } from "../../session/store.js";
import { getTranscriptRows } from "../../session/transcript-store.js";
import {
  buildAuthHeader,
  githubSignal,
  createPullRequest,
  findOpenPullRequestByBranch,
  updatePullRequest,
  GitHubApiError,
} from "../../integrations/github.js";
import {
  FileNotFoundError,
  GitOperationError,
  PathEscapeError,
  ReadRequiredError,
  SandboxUnavailableError,
} from "../../sandbox/errors.js";
import { gitHubErrorDetail } from "./github.js";
import { logger } from "../../logger.js";
import { publishSandboxStatus } from "../../session/stream.js";
import {
  withWorkspace,
  type Workspace,
  type WorkspaceOptions,
} from "../../sandbox/workspace.js";
import { repoKey } from "../../sandbox/paths.js";
import { readRepoFile } from "../../sandbox/tools/read-file.js";
import { editRepoFile } from "../../sandbox/tools/edit-file.js";
import { writeRepoFile } from "../../sandbox/tools/write-file.js";
import { execInRepo } from "../../sandbox/tools/exec.js";
import { openPullRequest } from "../../sandbox/tools/open-pull-request.js";
import { apiTool } from "./schema.js";
import type { Tool, ToolExecuteContext } from "./types.js";

export const COMMIT_AUTHOR = {
  name: "NightWarden",
  email: "noreply@nightwarden.local",
};

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "incident";
}

// Pure in the session row, so a resume recomputes the identical branch and
// openPullRequest finds its PR instead of opening a second one.
async function branchNameFor(sessionId: string): Promise<string> {
  const alert = (await getSession(sessionId))?.alerts[0]?.alert ?? null;
  const slug = alert === null ? "chat" : slugify(alert.alertType);
  return `nightwarden/fix-${slug}-${sessionId.slice(0, 8)}`;
}

// Named beside the tools themselves, because a transcript records a call and
// not the effect it had on a workspace that no longer exists.
const PATH_UNLOCKING_TOOLS: ReadonlySet<string> = new Set(["Read", "Write"]);

// The read state is the transcript's own: a path is seen once a clean Read or
// Write result is on the record, and pending while its call has not answered.
async function readStateFor(
  sessionId: string,
): Promise<{ seen: string[]; pending: string[] }> {
  const rows = await getTranscriptRows(sessionId);
  const isError = new Map<string, boolean>();
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.type === "tool_result") {
        isError.set(part.toolCallId, part.isError === true);
      }
    }
  }
  const seen: string[] = [];
  const pending: string[] = [];
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.type !== "tool_call" || !PATH_UNLOCKING_TOOLS.has(part.name)) {
        continue;
      }
      const path = part.input["path"];
      if (typeof path !== "string") continue;
      let key: string;
      try {
        key = repoKey(path);
      } catch {
        continue;
      }
      const errored = isError.get(part.toolCallId);
      if (errored === undefined) pending.push(key);
      else if (!errored) seen.push(key);
    }
  }
  return { seen, pending };
}

async function workspaceOptionsFor(
  sessionId: string,
): Promise<WorkspaceOptions | null> {
  const integration = await getGitHubIntegration();
  if (integration === null) return null;
  const config = await loadConfig();
  const { repoOwner, repoName } = integration;
  return {
    cloneUrl: `https://github.com/${repoOwner}/${repoName}.git`,
    branch: await branchNameFor(sessionId),
    authHeader: async () => {
      const row = await getGitHubIntegration();
      if (row === null) {
        return Promise.reject(
          new SandboxUnavailableError("GitHub integration was disconnected"),
        );
      }
      return Promise.resolve(buildAuthHeader(row.token));
    },
    limits: { cpus: config.sandboxCpus, memoryMb: config.sandboxMemoryMb },
    idleTimeoutMs: config.sandboxIdleTimeoutMs,
    workspacesDir: workspacesDir(),
    requireGvisor: config.sandboxRequireGvisor,
    network: config.sandboxNetwork,
    allowlistHosts: config.sandboxAllowlistHosts,
    proxyConfigDir: proxyDir(),
    readState: async () => await readStateFor(sessionId),
    onStatus: (stage) => publishSandboxStatus({ sessionId, stage }),
    commitAuthor: COMMIT_AUTHOR,
    pullRequests: {
      create: async (req) =>
        await createPullRequest(
          await tokenFor(),
          githubSignal(),
          repoOwner,
          repoName,
          {
            ...req,
            head: await branchNameFor(sessionId),
          },
        ),
      findOpenByBranch: async (branch) =>
        await findOpenPullRequestByBranch(
          await tokenFor(),
          githubSignal(),
          repoOwner,
          repoName,
          branch,
        ),
      update: async (prNumber, patch) =>
        await updatePullRequest(
          await tokenFor(),
          githubSignal(),
          repoOwner,
          repoName,
          prNumber,
          patch,
        ),
    },
    log: logger,
  };

  async function tokenFor(): Promise<string> {
    const row = await getGitHubIntegration();
    if (row === null) {
      throw new SandboxUnavailableError("GitHub integration was disconnected");
    }
    return row.token;
  }
}

// Decided together, because a message saying "reconnect the token" beside a
// class saying "expected miss" gives two answers to one question.
function corrective(err: unknown): {
  content: string;
  isError: true;
} {
  if (err instanceof FileNotFoundError) {
    return { content: err.message, isError: true };
  }
  if (err instanceof PathEscapeError) {
    return {
      content: `${err.message} Use a path relative to the repository root.`,
      isError: true,
    };
  }
  if (err instanceof ReadRequiredError) {
    return { content: err.message, isError: true };
  }
  if (err instanceof GitHubApiError) {
    return {
      content: `${gitHubErrorDetail(err)} Continue the investigation without repo tools.`,
      isError: true,
    };
  }
  if (
    err instanceof SandboxUnavailableError ||
    err instanceof GitOperationError
  ) {
    return {
      content: `${err.message} Repo tools are unavailable until the user fixes this (Integrations page). Continue the investigation without them.`,
      isError: true,
    };
  }
  return {
    content: err instanceof Error ? err.message : String(err),
    isError: true,
  };
}

// Every failure answers with a string, so a caller reading its own result back
// can tell the two apart without re-deriving the shape.
async function runRepoTool<T>(
  ctx: ToolExecuteContext,
  fn: (ws: Workspace) => Promise<T>,
): Promise<{ content: T | string; isError?: true }> {
  const options = await workspaceOptionsFor(ctx.sessionId);
  if (options === null) {
    return {
      content:
        "GitHub integration is not configured. The user can connect a repository from the Integrations page. Continue without repo tools.",
      isError: true,
    };
  }
  try {
    return {
      content: await withWorkspace(ctx.sessionId, options, fn),
    };
  } catch (err) {
    return corrective(err);
  }
}

// The session reference stays plain text: a link would come from PUBLIC_URL,
// which is the operator's address and not GitHub's to reach.
async function composePrBody(
  sessionId: string,
  branch: string,
  modelBody: string,
  filesChanged: string[],
): Promise<string> {
  const session = await getSession(sessionId);
  const alert = session?.alerts[0]?.alert ?? null;
  const sections: string[] = [];
  if (modelBody.trim().length > 0) sections.push(modelBody.trim());

  sections.push(
    alert === null
      ? "## Incident\n\nStarted from a NightWarden chat session."
      : `## Incident\n\n- Alert: ${alert.alertType}${alert.labels["severity"] === undefined ? "" : ` (${alert.labels["severity"]})`}\n- Fired at: ${alert.firedAt}`,
  );

  if (filesChanged.length > 0) {
    const shown = filesChanged.slice(0, 50);
    const more =
      filesChanged.length > shown.length
        ? `\n- [cut: ${filesChanged.length - shown.length} more]`
        : "";
    sections.push(
      `## Files changed\n\n${shown.map((f) => `- ${f}`).join("\n")}${more}`,
    );
  }

  sections.push(
    `---\nOpened by NightWarden from session "${session?.title ?? "unknown"}" (${sessionId}), branch \`${branch}\`.`,
  );
  return sections.join("\n\n");
}

// Edit, Write and Bash write, and still run unapproved: the write lands in a
// disposable container on a throwaway branch a human merges or does not.
const repoPath = z.string().meta({
  description: "The file's path relative to the repository root.",
});

const READ_INPUT = z.object({
  path: z.string().meta({
    description:
      "The file's path relative to the repository root, for example src/server.ts.",
  }),
  offset: z.number().int().optional().meta({
    description:
      "Which line to start reading from, counting from 1, as a whole number. Defaults to the first line.",
  }),
  limit: z.number().int().optional().meta({
    description:
      "How many lines to return, as a whole number. Both the default and the maximum are 2000.",
  }),
});

const EDIT_INPUT = z.object({
  path: repoPath,
  old_string: z.string().meta({
    description:
      "The exact text to replace, copied from what Read returned, without the line numbers.",
  }),
  new_string: z.string().meta({
    description: "The text to put in its place.",
  }),
  replace_all: z.boolean().optional().meta({
    description:
      "Set this to true to replace every occurrence rather than requiring exactly one. Defaults to false.",
  }),
});

const WRITE_INPUT = z.object({
  path: repoPath,
  content: z.string().meta({
    description:
      "The file's complete contents. Anything already in the file is replaced.",
  }),
});

const BASH_INPUT = z.object({
  command: z.string().meta({ description: "The shell command line to run." }),
  cwd: z.string().optional().meta({
    description:
      "The directory to run in, relative to the repository root. Defaults to the repository root itself.",
  }),
});

const OPEN_PULL_REQUEST_INPUT = z.object({
  title: z.string().meta({
    description:
      "The pull request's title: a short imperative summary of the fix, such as 'Raise the worker memory limit'.",
  }),
  body: z.string().optional().meta({
    description:
      "What the cause was, why this change addresses it, and what you ran to verify that it works.",
  }),
});

export const REPO_TOOLS: Tool[] = [
  apiTool({
    name: "Read",
    description:
      "Read a file from the isolated checkout of the connected repository. This is never a production machine, so use ReadHostFile when you want a file from a Docker host. The result is numbered by line.",
    input: READ_INPUT,
    effect: "read",
    policy: "auto",
    citable: true,
    renderAs: "text",
    timeoutMs: 60_000,
    execute: async (input: z.infer<typeof READ_INPUT>, ctx) => {
      const { path, offset, limit } = input;
      return await runRepoTool(
        ctx,
        async (ws) =>
          await readRepoFile(ws, {
            path,
            ...(offset !== undefined && { offset }),
            ...(limit !== undefined && { limit }),
          }),
      );
    },
  }),
  apiTool({
    name: "Edit",
    description:
      "Replace an exact piece of text in a repository file. The text you are replacing must match what is in the file exactly, and must appear exactly once unless you set replace_all. You must have read the file with the Read tool, or created it with the Write tool, earlier in this session. The result is a diff showing what changed.",
    input: EDIT_INPUT,
    effect: "write",
    policy: "auto",
    citable: true,
    renderAs: "diff",
    timeoutMs: 60_000,
    execute: async (input: z.infer<typeof EDIT_INPUT>, ctx) => {
      const { path, old_string, new_string, replace_all } = input;
      return await runRepoTool(
        ctx,
        async (ws) =>
          await editRepoFile(ws, {
            path,
            old_string,
            new_string,
            replace_all: replace_all === true,
          }),
      );
    },
  }),
  apiTool({
    name: "Write",
    description:
      "Create a new file in the repository, or replace an existing one completely. Replacing a file requires that you read it with the Read tool earlier in this session, and creating one leaves it editable without that. Any missing parent directories are created for you, and the result is a diff showing what changed. Prefer Edit whenever you are changing part of a file rather than all of it.",
    input: WRITE_INPUT,
    effect: "write",
    policy: "auto",
    citable: true,
    renderAs: "diff",
    timeoutMs: 60_000,
    execute: async (input: z.infer<typeof WRITE_INPUT>, ctx) => {
      const { path, content } = input;
      return await runRepoTool(
        ctx,
        async (ws) => await writeRepoFile(ws, { path, content }),
      );
    },
  }),
  apiTool({
    name: "Bash",
    description:
      "Run a shell command inside the isolated checkout of the connected repository, to build it, test it, search it or inspect its git history. This is never a production machine, so use DockerExec or K8sExec to run a command on a monitored server. If the output is long, you are shown its beginning and its end.",
    input: BASH_INPUT,
    effect: "write",
    policy: "auto",
    citable: true,
    renderAs: "terminal",
    timeoutMs: 300_000,
    execute: async (input: z.infer<typeof BASH_INPUT>, ctx) => {
      const { command, cwd } = input;
      return await runRepoTool(ctx, async (ws) => {
        const result = await execInRepo(
          ws,
          { command, ...(cwd !== undefined && { cwd }) },
          ctx.toolTimeoutMs,
        );
        // The provision-time install outcome rides the first Bash result -
        // the system prompt is already sent when the sandbox provisions.
        const note = ws.takeInstallNote();
        return note === null
          ? result
          : { ...result, output: `${note}\n\n${result.output}` };
      });
    },
  }),
  apiTool({
    name: "OpenPullRequest",
    description:
      "Propose the repository changes you made in this session as a draft pull request for a human to review. Verify your change with Bash before calling this, and say in the body what you ran. You can call it more than once: this session's branch has at most one open pull request, so a later call updates the existing one with your newest commits rather than opening a second. Details of the incident and a reference to this session are added to the body for you. If you have not committed any changes, it tells you there is nothing to propose, which is an answer about the branch rather than a failure.",
    input: OPEN_PULL_REQUEST_INPUT,
    // Unapproved on purpose: the PR is a proposal, GitHub's human merge is the
    // gate, and gating creation would stall the 3am AFK flow this exists for.
    effect: "write",
    policy: "auto",
    citable: true,
    renderAs: "change",
    // One PR per session branch, created or updated by branch identity, so a
    // second call after a crash refreshes the proposal rather than opening one.
    idempotent: true,
    timeoutMs: 600_000,
    execute: async (input: z.infer<typeof OPEN_PULL_REQUEST_INPUT>, ctx) => {
      const { title } = input;
      const modelBody = input.body ?? "";
      const result = await runRepoTool(
        ctx,
        async (ws) =>
          await openPullRequest(
            ws,
            { title },
            {
              composeBody: async (filesChanged) =>
                await composePrBody(
                  ctx.sessionId,
                  ws.branch,
                  modelBody,
                  filesChanged,
                ),
            },
          ),
      );
      // Having nothing to propose is a true answer about the branch, not a
      // fault, so it reads as a miss rather than as a failed pull request.
      const { content } = result;
      return typeof content !== "string" &&
        content.action === "nothing_to_propose"
        ? result
        : result;
    },
  }),
];

export const REPO_TOOL_NAMES: ReadonlySet<string> = new Set(
  REPO_TOOLS.map((t) => t.schema.name),
);
