import { decrypt } from "../../config/crypto.js";
import { proxyDir, workspacesDir } from "../../config/paths.js";
import { loadConfig } from "../../config/store.js";
import { getGitHubIntegration } from "../../db/github-integration.js";
import { getSession } from "../../db/sessions.js";
import {
  buildAuthHeader,
  createPullRequest,
  findOpenPullRequestByBranch,
  updatePullRequest,
  GitHubApiError,
} from "../../integrations/github.js";
import {
  insertExecutingRemediationAction,
  settleRemediationAction,
} from "../../db/remediation-actions.js";
import {
  GitOperationError,
  PathEscapeError,
  ReadRequiredError,
  SandboxUnavailableError,
  VerificationFailedError,
} from "../../sandbox/errors.js";
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
import {
  openPullRequest,
  type VerificationOutcome,
} from "../../sandbox/tools/open-pull-request.js";
import type { ServiceIdentity } from "@nightwatch/shared";
import type { Tool, ToolExecuteContext, ToolExecuteResult } from "./types.js";

const COMMIT_AUTHOR = { name: "Nightwatch", email: "noreply@nightwatch.local" };

function slugTarget(identity: ServiceIdentity): string {
  return identity.provider === "docker" ? identity.service : identity.workload;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "incident";
}

// A pure function of the session row: any resume recomputes the identical
// branch with nothing persisted, so one session maps to one branch forever.
export function branchNameFor(sessionId: string): string {
  const alert = getSession(sessionId)?.originatingAlert ?? null;
  const slug =
    alert === null
      ? "chat"
      : slugify(`${alert.alertType}-${slugTarget(alert.targetIdentifier)}`);
  return `nightwatch/fix-${slug}-${sessionId.slice(0, 8)}`;
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

function correctiveMessage(err: unknown): string {
  if (err instanceof PathEscapeError) {
    return `${err.message}. Use a path relative to the repository root.`;
  }
  if (err instanceof ReadRequiredError) return err.message;
  if (err instanceof VerificationFailedError) {
    const tail = err.output.slice(-2000);
    return `Verification failed (${err.command}) - the pull request was NOT opened and nothing was pushed:\n${tail}\nFix the failures, then call OpenPullRequest again.`;
  }
  if (err instanceof GitHubApiError) {
    return `GitHub request failed: ${err.message}. If the token is invalid or expired the operator must reconnect on the Integrations page. Continue the investigation without repo tools.`;
  }
  if (
    err instanceof SandboxUnavailableError ||
    err instanceof GitOperationError
  ) {
    return `${err.message}. Repo tools are unavailable until the operator fixes this (Integrations page). Continue the investigation without them.`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function runRepoTool(
  ctx: ToolExecuteContext,
  fn: (ws: Workspace) => Promise<unknown>,
): Promise<ToolExecuteResult> {
  const options = workspaceOptionsFor(ctx.sessionId);
  if (options === null) {
    return {
      content:
        "GitHub integration is not configured. The operator can connect a repository from the Integrations page. Continue without repo tools.",
      is_error: true,
    };
  }
  try {
    return {
      content: await withWorkspace(ctx.sessionId, options, fn),
    };
  } catch (err) {
    return { content: correctiveMessage(err), is_error: true };
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
  return { content: message, is_error: true };
}

// PR body section order (model text, then incident context, files, verification) is host
// policy; the session reference is plain text since no PUBLIC_URL exists yet to link to.
function composePrBody(
  sessionId: string,
  branch: string,
  modelBody: string,
  verification: VerificationOutcome,
  filesChanged: string[],
): string {
  const session = getSession(sessionId);
  const alert = session?.originatingAlert ?? null;
  const sections: string[] = [];
  if (modelBody.trim().length > 0) sections.push(modelBody.trim());

  sections.push(
    alert === null
      ? "## Incident\n\nStarted from a Nightwatch chat session."
      : `## Incident\n\n- Alert: ${alert.alertType} (${alert.severity})\n- Target: ${JSON.stringify(alert.targetIdentifier)}\n- Fired at: ${alert.firedAt}`,
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

  if (verification.ran) {
    const output = (verification.output ?? "").slice(-2000).trim();
    sections.push(
      `## Verification\n\n\`${verification.command ?? ""}\` passed (exit 0), run fresh in the sandbox just before this PR was pushed.\n\n\`\`\`\n${output}\n\`\`\``,
    );
  } else {
    sections.push(
      `## Verification\n\nNo automated verification was run: ${verification.reason ?? "unknown"}.`,
    );
  }

  sections.push(
    `---\nOpened by Nightwatch from session "${session?.title ?? "unknown"}" (${sessionId}), branch \`${branch}\`.`,
  );
  return sections.join("\n\n");
}

export const REPO_TOOLS: Tool[] = [
  {
    schema: {
      name: "Read",
      description:
        "Read a file from the connected repository's isolated checkout (never the production host). Returns numbered lines. Paths are relative to the repository root.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repo-relative file path, e.g. src/server.ts.",
          },
          offset: {
            type: "number",
            description: "1-based line to start from (default 1).",
          },
          limit: {
            type: "number",
            description: "Maximum lines to return (default and cap 2000).",
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
        "Replace an exact string in a repository file. old_string must match the current content exactly and appear exactly once (or pass replace_all: true). The file must have been read this session. Result is a unified diff.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative file path." },
          old_string: {
            type: "string",
            description: "Exact text to replace, copied from Read.",
          },
          new_string: { type: "string", description: "Replacement text." },
          replace_all: {
            type: "boolean",
            description: "Replace every occurrence (default false).",
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
        "Create a new repository file or fully overwrite an existing one (overwriting requires having read it this session). Parent directories are created. Result is a unified diff. Prefer Edit for targeted changes.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repo-relative file path." },
          content: {
            type: "string",
            description: "Full file content to write.",
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
        "Run a bash command inside the repository sandbox at the repo root (or cwd): build, test, grep, read-only git. This is the isolated checkout, never a production host. Use the structured repo tools for edits; Bash is for installing, observing and verifying. Output is capped head+tail.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Bash command line to run.",
          },
          cwd: {
            type: "string",
            description: "Repo-relative working directory (default repo root).",
          },
          description: {
            type: "string",
            description:
              'One short sentence describing what this command does, shown to the operator (e.g. "Install dependencies").',
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
        "Propose this session's repository changes as a draft pull request. Your verificationCommand runs fresh in the sandbox first - non-zero exit means nothing is pushed and you get the output back. Safe to call repeatedly: the session's branch has at most one open PR, so later calls update it with your latest commits. Incident context, the verification result and a session reference are appended to the body automatically.",
      input_schema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "PR title: imperative summary of the fix.",
          },
          body: {
            type: "string",
            description:
              "Explanation of the root cause and why this change fixes it.",
          },
          verificationCommand: {
            type: "string",
            description:
              'The repository\'s own check command (e.g. "pnpm test"), which must exit 0 for the PR to open. A single command or && chain; `||`, `;` and background `&` are rejected.',
          },
        },
        required: ["title", "verificationCommand"],
      },
    },
    // Deliberately read: the PR is a proposal, the merge is the GitHub-enforced human gate, and
    // gating creation would stall the 3am AFK flow this product exists for.
    access: "read",
    timeoutMs: 600_000,
    on: "api",
    execute: (input, ctx) => {
      const title = requireString(input, "title");
      if (title === null) {
        return Promise.resolve(badInput("title (string) is required."));
      }
      const modelBody = requireString(input, "body") ?? "";
      const verificationCommand = requireString(input, "verificationCommand");
      // `||`, `;` and background `&` can mask a failing exit code; pipes stay
      // honest because the sandbox shell runs with pipefail.
      if (
        verificationCommand !== null &&
        /\|\||;|(?<!&)&(?!&)/.test(verificationCommand)
      ) {
        return Promise.resolve(
          badInput(
            "verificationCommand must be a single command or && chain - `||`, `;` and background `&` are not allowed. Pass the repository's real check command.",
          ),
        );
      }
      return runRepoTool(ctx, (ws) =>
        openPullRequest(
          ws,
          {
            title,
            verificationCommand,
            verificationTimeoutMs: ctx.toolTimeoutMs,
          },
          {
            beginAudit: () =>
              insertExecutingRemediationAction({
                toolUseId: ctx.toolUseId,
                sessionId: ctx.sessionId,
                toolName: "OpenPullRequest",
                input: { title, body: modelBody },
                resolvedBy: "agent",
              }),
            settleAudit: (ok, detail) => {
              settleRemediationAction(
                ctx.sessionId,
                ctx.toolUseId,
                ok ? "executed" : "failed",
                detail,
              );
            },
            composeBody: (verification, filesChanged) =>
              composePrBody(
                ctx.sessionId,
                ws.branch,
                modelBody,
                verification,
                filesChanged,
              ),
          },
        ),
      );
    },
  },
];

export const REPO_TOOL_NAMES: ReadonlySet<string> = new Set(
  REPO_TOOLS.map((t) => t.schema.name),
);
