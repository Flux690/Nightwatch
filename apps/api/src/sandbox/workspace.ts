import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  apiRunsAsRoot,
  createSandboxContainer,
  destroyContainer,
  disconnectAllNetworks,
  execInContainer,
  type SandboxLimits,
} from "./docker.js";
import {
  cloneAndCheckout,
  commitAll,
  hasUnpushedWork,
  isDirty,
  push,
  type CommitAuthor,
} from "./git.js";
import { INSTALL_TIMEOUT_MS, runInstall, type SetupResult } from "./install.js";
import { capOutput } from "./output.js";

// Structural subset of pino so the host injects its logger instead of the
// module importing one - a hard requirement of the package-shaped boundary.
export interface SandboxLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PullRequestRef {
  number: number;
  url: string;
  draft: boolean;
}

export interface WorkspaceOptions {
  cloneUrl: string;
  branch: string;
  // Fetched per operation, never cached: the stored token may rotate while a
  // workspace is alive.
  authHeader(): Promise<string>;
  limits: SandboxLimits;
  idleTimeoutMs: number;
  // Absolute host dir the checkout is created under and bind-mounted from.
  // Host-provided and absolute by contract: the sandbox never guesses a path,
  // and a Docker bind rejects a relative source.
  workspacesDir: string;
  // Fail-loud opt-in: refuse to create a sandbox when the host has no gVisor.
  requireGvisor: boolean;
  // "none" detaches every network after the agent-free dependency install, so
  // the agent phase has no egress path; "open" keeps the default bridge.
  network: "none" | "open";
  commitAuthor: CommitAuthor;
  pullRequests: {
    create(req: {
      title: string;
      body: string;
      draft: boolean;
    }): Promise<PullRequestRef>;
    findOpenByBranch(branch: string): Promise<PullRequestRef | null>;
    update(
      prNumber: number,
      patch: { title: string; body: string },
    ): Promise<void>;
  };
  log?: SandboxLog;
}

export interface ExecOutcome {
  exitCode: number;
  output: string;
  truncated: boolean;
}

export interface Workspace {
  readonly sessionId: string;
  readonly dir: string;
  readonly branch: string;
  // Backs the read-before-edit guard; per session by construction because the
  // workspace is per session.
  readonly readPaths: Set<string>;
  // Outcome of the setup-phase dependency install (null: nothing to install).
  // A non-zero exitCode is survivable - the agent can still read, edit and
  // open a PR - but it must surface everywhere the result is consumed.
  readonly setup: SetupResult | null;
  readonly options: WorkspaceOptions;
  exec(
    command: string,
    opts: { cwd?: string; timeoutMs: number },
  ): Promise<ExecOutcome>;
}

interface Entry {
  workspace: Workspace;
  containerId: string;
  idleTimer: NodeJS.Timeout | null;
  busy: number;
  options: WorkspaceOptions;
}

// Private to this module by design: tools receive ctx.sessionId and ask for
// their workspace here - nothing else may hold container references. The run
// process exits on every gated suspend, so no run-local state is allowed.
const sessions = new Map<string, Entry>();
const creating = new Map<string, Promise<Entry>>();

// One-shot: the root-API recommendation is a deployment fact, not a per-session
// event, so it is logged once per process rather than on every sandbox.
let warnedRootApi = false;

function homeDirFor(dir: string): string {
  return `${dir}.home`;
}

async function createEntry(
  sessionId: string,
  options: WorkspaceOptions,
): Promise<Entry> {
  const dir = join(options.workspacesDir, sessionId);
  const homeDir = homeDirFor(dir);
  // A leftover dir (crash, reaped container) would break the clone; the branch
  // is the durable state, so a fresh clone is always correct.
  await rm(dir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const authHeader = await options.authHeader();
  await cloneAndCheckout({
    url: options.cloneUrl,
    branch: options.branch,
    dir,
    authHeader,
  });
  // Local-only ignore: the setup install guarantees node_modules exists, and a
  // repo without a .gitignore must never get it checkpoint-committed.
  await appendFile(join(dir, ".git", "info", "exclude"), "node_modules/\n");
  if (apiRunsAsRoot() && !warnedRootApi) {
    warnedRootApi = true;
    options.log?.warn(
      { sessionId },
      "API runs as root, so sandbox containers run as root too; run the API as a non-root user for full sandbox hardening",
    );
  }
  const containerId = await createSandboxContainer({
    sessionId,
    workspaceDir: dir,
    homeDir,
    limits: options.limits,
    requireGvisor: options.requireGvisor,
  });

  // Two phases: the agent-free install runs while the network is attached,
  // then every network is detached (and verified gone) before any agent
  // command can run - a failure here must not leak a networked container.
  let setup: SetupResult | null = null;
  try {
    setup = await runInstall(dir, async (command) => {
      const result = await execInContainer(containerId, command, {
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      return { exitCode: result.exitCode, output: result.output };
    });
    if (setup !== null && setup.exitCode !== 0) {
      options.log?.warn(
        {
          sessionId,
          command: setup.command,
          exitCode: setup.exitCode,
          tail: setup.outputTail,
        },
        "sandbox dependency install failed; session continues without installed dependencies",
      );
    } else if (setup !== null && !setup.frozen) {
      options.log?.warn(
        { sessionId, command: setup.command },
        "sandbox dependencies installed without a frozen lockfile (non-deterministic resolution)",
      );
    }
    if (options.network === "none") {
      await disconnectAllNetworks(containerId);
    }
  } catch (err) {
    await destroyContainer(containerId).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    throw err;
  }

  const workspace: Workspace = {
    sessionId,
    dir,
    branch: options.branch,
    readPaths: new Set<string>(),
    setup,
    options,
    async exec(command, opts) {
      const result = await execInContainer(containerId, command, opts);
      const capped = capOutput(result.output);
      return {
        exitCode: result.exitCode,
        output: capped.text,
        truncated: capped.truncated,
      };
    },
  };
  const entry: Entry = {
    workspace,
    containerId,
    idleTimer: null,
    busy: 0,
    options,
  };
  sessions.set(sessionId, entry);
  options.log?.info({ sessionId, branch: options.branch }, "sandbox created");
  return entry;
}

function armIdleTimer(sessionId: string, entry: Entry): void {
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
  const timer = setTimeout(() => {
    entry.idleTimer = null;
    if (entry.busy > 0) {
      armIdleTimer(sessionId, entry);
      return;
    }
    void teardown(sessionId, "idle").catch((err: unknown) => {
      entry.options.log?.warn(
        { sessionId, err: err instanceof Error ? err.message : String(err) },
        "sandbox idle teardown failed",
      );
    });
  }, entry.options.idleTimeoutMs);
  timer.unref();
  entry.idleTimer = timer;
}

// Single-flight acquire: the first tool call of a burst pays clone+start; the
// idle timer is disarmed while any call is in flight, so teardown can never
// race live work - the sandbox only ever dies when the agent isn't running.
export async function withWorkspace<T>(
  sessionId: string,
  options: WorkspaceOptions,
  fn: (ws: Workspace) => Promise<T>,
): Promise<T> {
  let entry = sessions.get(sessionId);
  if (!entry) {
    let pending = creating.get(sessionId);
    if (!pending) {
      pending = createEntry(sessionId, options).finally(() => {
        creating.delete(sessionId);
      });
      creating.set(sessionId, pending);
    }
    entry = await pending;
  }
  entry.busy++;
  if (entry.idleTimer !== null) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  try {
    return await fn(entry.workspace);
  } finally {
    entry.busy--;
    if (entry.busy === 0 && sessions.get(sessionId) === entry) {
      armIdleTimer(sessionId, entry);
    }
  }
}

// Lossless teardown: dirty work is checkpoint-committed and pushed before the
// container and dir go. An idle-path push failure aborts (work is never lost);
// force (disconnect) proceeds and logs it.
export async function teardown(
  sessionId: string,
  reason: string,
  force = false,
): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  if (entry.busy > 0 && !force) return;
  const { workspace, options } = entry;
  try {
    if (await isDirty(workspace.dir)) {
      await commitAll(
        workspace.dir,
        "nightwatch: checkpoint at sandbox teardown",
        options.commitAuthor,
      );
    }
    if (await hasUnpushedWork(workspace.dir)) {
      await push(workspace.dir, workspace.branch, await options.authHeader());
    }
  } catch (err) {
    options.log?.warn(
      {
        sessionId,
        reason,
        err: err instanceof Error ? err.message : String(err),
      },
      force
        ? "sandbox teardown: push failed, discarding work"
        : "sandbox teardown aborted: push failed, keeping workspace",
    );
    if (!force) {
      armIdleTimer(sessionId, entry);
      return;
    }
  }
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
  sessions.delete(sessionId);
  await destroyContainer(entry.containerId).catch(() => undefined);
  await rm(workspace.dir, { recursive: true, force: true });
  await rm(homeDirFor(workspace.dir), { recursive: true, force: true });
  options.log?.info({ sessionId, reason }, "sandbox torn down");
}

export async function teardownAll(reason: string): Promise<void> {
  await Promise.all(
    [...sessions.keys()].map((id) => teardown(id, reason, true)),
  );
}
