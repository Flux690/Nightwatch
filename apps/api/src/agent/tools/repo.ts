import { decrypt } from "../../secrets.js";
import { proxyDir, workspacesDir } from "../../env/paths.js";
import { loadConfig } from "../../config/store.js";
import { getGitHubIntegration } from "../../db/integrations.js";
import { getSession } from "../../db/sessions.js";
import {
  buildAuthHeader,
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
import { classifyGitHubError, gitHubErrorDetail } from "./github.js";
import { logger } from "../../logger.js";
import { publishSandboxStatus } from "../../session/stream.js";
import {
  withWorkspace,
  type Workspace,
  type WorkspaceOptions,
} from "../../sandbox/workspace.js";
import { readRepoFile } from "../../sandbox/tools/read-file.js";
import { editRepoFile } from "../../sandbox/tools/edit-file.js";
import { writeRepoFile } from "../../sandbox/tools/write-file.js";
import { execInRepo } from "../../sandbox/tools/exec.js";
import { openPullRequest } from "../../sandbox/tools/open-pull-request.js";
import type { ToolOutcome } from "@nightwarden/shared";
import type { Tool, ToolExecuteContext, ToolExecuteResult } from "./types.js";

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

// Pure function of the session row, so any resume recomputes the identical branch and
// openPullRequest finds its existing PR instead of opening a second one. The alert type
// is decoration, for a human scanning the branch list.
export function branchNameFor(sessionId: string): string {
  const alert = getSession(sessionId)?.alerts[0]?.alert ?? null;
  const slug = alert === null ? "chat" : slugify(alert.alertType);
  return `nightwarden/fix-${slug}-${sessionId.slice(0, 8)}`;
}

function workspaceOptionsFor(sessionId: string): WorkspaceOptions | null {
  const integration = getGitHubIntegration();
  if (integration === null) return null;
  const config = loadConfig();
  const { repoOwner, repoName } = integration;
  return {
    cloneUrl: `https://github.com/${repoOwner}/${repoName}.git`,
    branch: branchNameFor(sessionId),
    authHeader: () => {
      const row = getGitHubIntegration();
      if (row === null) {
        return Promise.reject(
          new SandboxUnavailableError("GitHub integration was disconnected"),
        );
      }
      return Promise.resolve(buildAuthHeader(decrypt(row.tokenEncrypted)));
    },
    limits: { cpus: config.sandboxCpus, memoryMb: config.sandboxMemoryMb },
    idleTimeoutMs: config.sandboxIdleTimeoutMs,
    workspacesDir: workspacesDir(),
    requireGvisor: config.sandboxRequireGvisor,
    network: config.sandboxNetwork,
    allowlistHosts: config.sandboxAllowlistHosts,
    proxyConfigDir: proxyDir(),
    onStatus: (stage) => publishSandboxStatus({ sessionId, stage }),
    commitAuthor: COMMIT_AUTHOR,
    pullRequests: {
      create: (req) =>
        createPullRequest(tokenFor(), repoOwner, repoName, {
          ...req,
          head: branchNameFor(sessionId),
        }),
      findOpenByBranch: (branch) =>
        findOpenPullRequestByBranch(tokenFor(), repoOwner, repoName, branch),
      update: (prNumber, patch) =>
        updatePullRequest(tokenFor(), repoOwner, repoName, prNumber, patch),
    },
    log: logger,
  };

  function tokenFor(): string {
    const row = getGitHubIntegration();
    if (row === null) {
      throw new SandboxUnavailableError("GitHub integration was disconnected");
    }
    return decrypt(row.tokenEncrypted);
  }
}

// The sentence the model reads and the class the console renders are decided
// together: a message that says "reconnect the token" while the class says
// "expected miss" would be two answers to one question.
function corrective(err: unknown): { content: string; outcome: ToolOutcome } {
  if (err instanceof FileNotFoundError) {
    return { content: err.message, outcome: "expected_miss" };
  }
  if (err instanceof PathEscapeError) {
    return {
      content: `${err.message}. Use a path relative to the repository root.`,
      outcome: "system",
    };
  }
  if (err instanceof ReadRequiredError) {
    return { content: err.message, outcome: "system" };
  }
  if (err instanceof GitHubApiError) {
    return {
      content: `${gitHubErrorDetail(err)} Continue the investigation without repo tools.`,
      outcome: classifyGitHubError(err),
    };
  }
  if (
    err instanceof SandboxUnavailableError ||
    err instanceof GitOperationError
  ) {
    return {
      content: `${err.message}. Repo tools are unavailable until the operator fixes this (Integrations page). Continue the investigation without them.`,
      outcome: "system",
    };
  }
  return {
    content: err instanceof Error ? err.message : String(err),
    outcome: "system",
  };
}

// Generic in what the tool returns: every failure here answers with a string, so
// a caller that needs to read its own result back can tell the two apart instead
// of re-deriving the shape it just produced.
async function runRepoTool<T>(
  ctx: ToolExecuteContext,
  fn: (ws: Workspace) => Promise<T>,
): Promise<{ content: T | string; outcome?: ToolOutcome }> {
  const options = workspaceOptionsFor(ctx.sessionId);
  if (options === null) {
    return {
      content:
        "GitHub integration is not configured. The operator can connect a repository from the Integrations page. Continue without repo tools.",
      outcome: "permission",
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

function requireString(
  input: Record<string, unknown>,
  key: string,
): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function optionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

function badInput(message: string): ToolExecuteResult {
  return { content: message, outcome: "system" };
}

// PR body section order (model text, then incident context, files) is host
// policy; the session reference is plain text since no PUBLIC_URL exists yet to link to.
function composePrBody(
  sessionId: string,
  branch: string,
  modelBody: string,
  filesChanged: string[],
): string {
  const session = getSession(sessionId);
  const alert = session?.alerts[0]?.alert ?? null;
  const sections: string[] = [];
  if (modelBody.trim().length > 0) sections.push(modelBody.trim());

  sections.push(
    alert === null
      ? "## Incident\n\nStarted from a NightWarden chat session."
      : `## Incident\n\n- Alert: ${alert.alertType}${alert.severity === null ? "" : ` (${alert.severity})`}\n- Fired at: ${alert.firedAt}`,
  );

  if (filesChanged.length > 0) {
    const shown = filesChanged.slice(0, 50);
    const more =
      filesChanged.length > shown.length
        ? `\n- ... and ${filesChanged.length - shown.length} more`
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

export const REPO_TOOLS: Tool[] = [
  {
    schema: {
      name: "Read",
      description:
        "Read a file from the isolated checkout of the connected repository. This is never a production machine, so use ReadHostFile when you want a file from a Docker host. The result is numbered by line, and you must read a file with this before you may edit it.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "The file's path relative to the repository root, for example src/server.ts.",
          },
          offset: {
            type: "number",
            description:
              "Which line to start reading from, counting from 1. Defaults to the first line.",
          },
          limit: {
            type: "number",
            description:
              "How many lines to return. Both the default and the maximum are 2000.",
          },
        },
        required: ["path"],
      },
    },
    access: "read",
    timeoutMs: 60_000,
    on: "api",
    execute: (input, ctx) => {
      const path = requireString(input, "path");
      if (path === null) {
        return Promise.resolve(badInput("path (string) is required."));
      }
      return runRepoTool(ctx, (ws) =>
        readRepoFile(ws, {
          path,
          ...(optionalNumber(input, "offset") !== undefined && {
            offset: optionalNumber(input, "offset"),
          }),
          ...(optionalNumber(input, "limit") !== undefined && {
            limit: optionalNumber(input, "limit"),
          }),
        }),
      );
    },
  },
  {
    schema: {
      name: "Edit",
      description:
        "Replace an exact piece of text in a repository file. The text you are replacing must match what is in the file exactly, and must appear exactly once unless you set replace_all. You must have read the file with Read earlier in this session. The result is a diff showing what changed.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file's path relative to the repository root.",
          },
          old_string: {
            type: "string",
            description:
              "The exact text to replace, copied from what Read returned, without the line numbers.",
          },
          new_string: {
            type: "string",
            description: "The text to put in its place.",
          },
          replace_all: {
            type: "boolean",
            description:
              "Set this to true to replace every occurrence rather than requiring exactly one. Defaults to false.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    access: "read",
    timeoutMs: 60_000,
    on: "api",
    execute: (input, ctx) => {
      const path = requireString(input, "path");
      const oldString = requireString(input, "old_string");
      const newString = requireString(input, "new_string");
      if (path === null || oldString === null || newString === null) {
        return Promise.resolve(
          badInput("path, old_string and new_string (strings) are required."),
        );
      }
      return runRepoTool(ctx, (ws) =>
        editRepoFile(ws, {
          path,
          old_string: oldString,
          new_string: newString,
          replace_all: input["replace_all"] === true,
        }),
      );
    },
  },
  {
    schema: {
      name: "Write",
      description:
        "Create a new file in the repository, or replace an existing one completely. Replacing a file requires that you read it with Read earlier in this session. Any missing parent directories are created for you, and the result is a diff showing what changed. Prefer Edit whenever you are changing part of a file rather than all of it.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The file's path relative to the repository root.",
          },
          content: {
            type: "string",
            description:
              "The file's complete contents. Anything already in the file is replaced.",
          },
        },
        required: ["path", "content"],
      },
    },
    access: "read",
    timeoutMs: 60_000,
    on: "api",
    execute: (input, ctx) => {
      const path = requireString(input, "path");
      const content = requireString(input, "content");
      if (path === null || content === null) {
        return Promise.resolve(
          badInput("path and content (strings) are required."),
        );
      }
      return runRepoTool(ctx, (ws) => writeRepoFile(ws, { path, content }));
    },
  },
  {
    schema: {
      name: "Bash",
      description:
        "Run a shell command inside the isolated checkout of the connected repository, to build it, test it, search it or inspect its git history. This is never a production machine, so use DockerBash or K8sBash when you want to run something there. Make changes with Edit and Write rather than with shell commands; this tool is for installing, observing and verifying. If the output is long, you are shown its beginning and its end.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command line to run.",
          },
          cwd: {
            type: "string",
            description:
              "The directory to run in, relative to the repository root. Defaults to the repository root itself.",
          },
          description: {
            type: "string",
            description:
              'One short sentence saying what this command does, which the operator sees, for example "Install dependencies".',
          },
        },
        required: ["command"],
      },
    },
    access: "read",
    timeoutMs: 300_000,
    on: "api",
    execute: (input, ctx) => {
      const command = requireString(input, "command");
      if (command === null) {
        return Promise.resolve(badInput("command (string) is required."));
      }
      const cwd = requireString(input, "cwd");
      return runRepoTool(ctx, async (ws) => {
        const result = await execInRepo(
          ws,
          { command, ...(cwd !== null && { cwd }) },
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
  },
  {
    schema: {
      name: "OpenPullRequest",
      description:
        "Propose the repository changes you made in this session as a draft pull request for a human to review. Verify your change with Bash before calling this, and say in the body what you ran. You can call it more than once: this session's branch has at most one open pull request, so a later call updates the existing one with your newest commits rather than opening a second. Details of the incident and a reference to this session are added to the body for you. If you have not committed any changes, it tells you there is nothing to propose, which is an answer about the branch rather than a failure.",
      input_schema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "The pull request's title: a short imperative summary of the fix, such as 'Raise the worker memory limit'.",
          },
          body: {
            type: "string",
            description:
              "What the cause was, why this change addresses it, and what you ran to verify that it works.",
          },
        },
        required: ["title"],
      },
    },
    // Deliberately read: the PR is a proposal, the merge is the GitHub-enforced human gate, and
    // gating creation would stall the 3am AFK flow this product exists for.
    access: "read",
    timeoutMs: 600_000,
    on: "api",
    execute: async (input, ctx) => {
      const title = requireString(input, "title");
      if (title === null) return badInput("title (string) is required.");
      const modelBody = requireString(input, "body") ?? "";
      const result = await runRepoTool(ctx, (ws) =>
        openPullRequest(
          ws,
          { title },
          {
            composeBody: (filesChanged) =>
              composePrBody(ctx.sessionId, ws.branch, modelBody, filesChanged),
          },
        ),
      );
      // Having nothing to propose is a true answer about the branch, not a
      // fault, so it reads as a miss rather than as a failed pull request.
      const { content } = result;
      return typeof content !== "string" &&
        content.action === "nothing_to_propose"
        ? { ...result, outcome: "expected_miss" }
        : result;
    },
  },
];

export const REPO_TOOL_NAMES: ReadonlySet<string> = new Set(
  REPO_TOOLS.map((t) => t.schema.name),
);
