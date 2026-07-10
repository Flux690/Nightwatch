import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  apiRunsAsRoot,
  createSandboxContainer,
  destroyContainer,
  execInContainer,
  type SandboxLimits,
} from "./docker.js";
import { ensureProxy, EGRESS_NETWORK, EGRESS_PROXY_URL } from "./egress.js";
import {
  cloneAndCheckout,
  commitAll,
  hasUnpushedWork,
  isDirty,
  push,
  type CommitAuthor,
} from "./git.js";
import { capOutput } from "./output.js";

export function workspacesRoot(): string {
  return (
    process.env["NIGHTWATCH_WORKSPACES_DIR"] ?? "/var/nightwatch/workspaces"
  );
}

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
  // Fail-loud opt-in: refuse to create a sandbox when the host has no gVisor.
  requireGvisor: boolean;
  // Network egress: "allowlist" forces the sandbox through the filtering proxy
  // on the Internal network; "open" leaves it on the default bridge.
  egress: { policy: "allowlist" | "open"; allowlist: string[] };
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

async function createEntry(
  sessionId: string,
  options: WorkspaceOptions,
): Promise<Entry> {
  const dir = join(workspacesRoot(), sessionId);
  // A leftover dir (crash, reaped container) would break the clone; the branch
  // is the durable state, so a fresh clone is always correct.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const authHeader = await options.authHeader();
  await cloneAndCheckout({
    url: options.cloneUrl,
    branch: options.branch,
    dir,
    authHeader,
  });
  if (apiRunsAsRoot() && !warnedRootApi) {
    warnedRootApi = true;
    options.log?.warn(
      { sessionId },
      "API runs as root, so sandbox containers run as root too; run the API as a non-root user for full sandbox hardening",
    );
  }
  // Bring the shared proxy up before the sandbox that depends on it, so the
  // very first install has a working egress path.
  let egress: { networkName: string; proxyUrl: string } | undefined;
  if (options.egress.policy === "allowlist") {
    await ensureProxy(options.egress.allowlist);
    egress = { networkName: EGRESS_NETWORK, proxyUrl: EGRESS_PROXY_URL };
  }
  const containerId = await createSandboxContainer({
    sessionId,
    workspaceDir: dir,
    limits: options.limits,
    requireGvisor: options.requireGvisor,
    ...(egress !== undefined && { egress }),
  });

  const workspace: Workspace = {
    sessionId,
    dir,
    branch: options.branch,
    readPaths: new Set<string>(),
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

// Teardown is lossless by construction: dirty work becomes a checkpoint
// commit and anything unpushed is pushed before container and workspace go
// away. On the idle path a push failure aborts the teardown so work is never
// destroyed silently; force (disconnect) proceeds and says so via the log.
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
  options.log?.info({ sessionId, reason }, "sandbox torn down");
}

export async function teardownAll(reason: string): Promise<void> {
  await Promise.all(
    [...sessions.keys()].map((id) => teardown(id, reason, true)),
  );
}
