import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  apiRunsAsRoot,
  createSandboxContainer,
  destroyContainer,
  execInContainer,
  type SandboxLimits,
  type SandboxNetworkAttachment,
} from "./docker.js";
import {
  cloneAndCheckout,
  commitAll,
  currentBranch,
  hasUnpushedWork,
  isDirty,
  push,
  type CommitAuthor,
} from "./git.js";
import { resolveInstallPlan } from "./install.js";
import { ensureProxy, proxyEnv } from "./proxy.js";
import { capOutput } from "./output.js";

// Structural subset of pino so the host injects its logger instead of the
// module importing one - a hard requirement of the package-shaped boundary.
export interface SandboxLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

// Provisioning progress for the console: creation is slow (clone, image pull,
// container start, dependency install) and would otherwise look like a hang on
// the first repo tool.
type SandboxStage = "cloning" | "starting" | "installing" | "ready" | "failed";

interface PullRequestRef {
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
  // Host dir the checkout is bind-mounted from; must be absolute since the
  // sandbox never guesses a path and Docker rejects a relative bind source.
  workspacesDir: string;
  // Fail-loud opt-in: refuse to create a sandbox when the host has no gVisor.
  requireGvisor: boolean;
  // "allowlist" routes egress through the shared enforcing proxy; "none" gives
  // no network from birth; "open" keeps the default bridge.
  network: "allowlist" | "open" | "none";
  // Hosts the proxy may reach, and where its generated config lives.
  allowlistHosts: string[];
  proxyConfigDir: string;
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
  /* Paths this session has already read. A workspace is re-provisioned whenever
     one is not live - a restart, or the idle sweep between two turns - and
     without this the model's next edit is refused for a file its own context
     says it read. The host supplies them: it has the transcript, and the sandbox
     keeps no history of its own. */
  readPaths?(): string[];
  onStatus?(stage: SandboxStage): void;
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
  // Backs the read-before-edit guard, holding canonical repo-relative names.
  // Per session by construction, because the workspace is.
  readonly readPaths: Set<string>;
  readonly options: WorkspaceOptions;
  exec(
    command: string,
    opts: { cwd?: string; timeoutMs: number },
  ): Promise<ExecOutcome>;
  // Single-consumption outcome of the provision-time dependency install; the
  // first Bash result carries it to the model, later calls get null.
  takeInstallNote(): string | null;
}

interface Entry {
  workspace: Workspace;
  containerId: string;
  idleTimer: NodeJS.Timeout | null;
  busy: number;
  options: WorkspaceOptions;
}

// Private by design: tools receive ctx.sessionId and ask for their workspace
// here, since the run process exits on every gated suspend.
const sessions = new Map<string, Entry>();
const creating = new Map<string, Promise<Entry>>();

// One-shot: the root-API recommendation is a deployment fact, not a per-session
// event, so it is logged once per process rather than on every sandbox.
let warnedRootApi = false;

// Single owner of the "<dir>.home" sibling-mount convention; salvage derives
// its skip-and-remove logic from this too.
export function homeDirFor(dir: string): string {
  return `${dir}.home`;
}

// In allowlist mode the shared proxy (with current config) must exist before
// the container attaches to its network; other modes need no preparation.
async function networkAttachment(
  options: WorkspaceOptions,
): Promise<SandboxNetworkAttachment> {
  if (options.network !== "allowlist") return { mode: options.network };
  const proxy = await ensureProxy({
    hosts: options.allowlistHosts,
    configDir: options.proxyConfigDir,
  });
  return {
    mode: "allowlist",
    networkName: proxy.networkName,
    proxyEnv: proxyEnv(proxy.proxyUrl),
  };
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;

// Deterministic provision-time install, fail-open by contract: every outcome -
// success, failure, skip - becomes a note for the model, never a dead sandbox.
async function installDependencies(
  containerId: string,
  dir: string,
  sessionId: string,
  options: WorkspaceOptions,
): Promise<string> {
  if (options.network === "none") {
    return 'Dependency install was skipped: the sandbox is networkless (operator setting "none").';
  }
  const plan = await resolveInstallPlan(dir);
  if (plan === null) {
    return "No Node lockfile was found, so no dependencies were pre-installed.";
  }
  options.onStatus?.("installing");
  try {
    const result = await execInContainer(containerId, plan.command, {
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      options.log?.info(
        { sessionId, command: plan.command },
        "sandbox dependencies installed",
      );
      return `Dependencies were installed when this sandbox was created: \`${plan.command}\` exited 0.`;
    }
    const tail = capOutput(result.output).text.slice(-2000);
    // Log the output tail too, not just the exit code: it names the blocked host
    // (allowlist) or the failing binary (platform mismatch) so the operator can
    // tell the two apart. The tail carries merged stdout+stderr.
    options.log?.warn(
      { sessionId, command: plan.command, exitCode: result.exitCode, tail },
      "sandbox dependency install failed",
    );
    return `Dependency install failed when this sandbox was created: \`${plan.command}\` exited ${result.exitCode}. Fix or work around this before building or testing. Output tail:\n${tail}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.log?.warn(
      { sessionId, command: plan.command, err: message },
      "sandbox dependency install did not complete",
    );
    return `Dependency install failed when this sandbox was created: \`${plan.command}\` did not complete (${message}). Fix or work around this before building or testing.`;
  }
}

/* The same rule the teardown obeys, on the one other path that removes a
   checkout. Best-effort by nature: no repo here at all is the ordinary case,
   and every failure means the folder was already beyond saving. */
async function pushLeftovers(
  dir: string,
  options: WorkspaceOptions,
): Promise<void> {
  try {
    if (await isDirty(dir)) {
      await commitAll(
        dir,
        "nightwarden: checkpoint before reprovisioning",
        options.commitAuthor,
      );
    }
    if (await hasUnpushedWork(dir)) {
      await push(dir, await currentBranch(dir), await options.authHeader());
    }
  } catch {
    // Nothing to say: a fresh session has no folder, and a folder that cannot
    // be pushed is one boot salvage already declined to rescue.
  }
}

async function createEntry(
  sessionId: string,
  options: WorkspaceOptions,
): Promise<Entry> {
  try {
    return await provisionEntry(sessionId, options);
  } catch (err) {
    options.onStatus?.("failed");
    throw err;
  }
}

async function provisionEntry(
  sessionId: string,
  options: WorkspaceOptions,
): Promise<Entry> {
  const dir = join(options.workspacesDir, sessionId);
  const homeDir = homeDirFor(dir);
  // A leftover dir (crash, reaped container) would break the clone; the branch
  // is the durable state, so a fresh clone is always correct - but only once
  // what is here has reached it, since a push that failed left the only copy.
  await pushLeftovers(dir, options);
  await rm(dir, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  options.onStatus?.("cloning");
  const authHeader = await options.authHeader();
  await cloneAndCheckout({
    url: options.cloneUrl,
    branch: options.branch,
    dir,
    authHeader,
  });
  // Local-only ignore: a repo without a .gitignore must never get an
  // agent-installed node_modules checkpoint-committed.
  await appendFile(join(dir, ".git", "info", "exclude"), "node_modules/\n");
  if (apiRunsAsRoot() && !warnedRootApi) {
    warnedRootApi = true;
    options.log?.warn(
      { sessionId },
      "API runs as root, so sandbox containers run as root too; run the API as a non-root user for full sandbox hardening",
    );
  }
  options.onStatus?.("starting");
  const network = await networkAttachment(options);
  const containerId = await createSandboxContainer({
    sessionId,
    workspaceDir: dir,
    homeDir,
    limits: options.limits,
    requireGvisor: options.requireGvisor,
    network,
    gitIdentity: options.commitAuthor,
  });

  let installNote: string | null = await installDependencies(
    containerId,
    dir,
    sessionId,
    options,
  );

  const workspace: Workspace = {
    sessionId,
    dir,
    branch: options.branch,
    readPaths: new Set<string>(options.readPaths?.() ?? []),
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
    takeInstallNote() {
      const note = installNote;
      installNote = null;
      return note;
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
  options.onStatus?.("ready");
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

// Single-flight acquire: idle timer is disarmed while any call is in flight,
// so teardown can never race live work.
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

// Why the sandbox is going. Only the idle sweep defers to work in flight; the
// others mean the session is going whether that work finishes or not.
export type TeardownReason = "idle" | "deleted" | "disconnected";

/* One rule, no modes: never drop a checkout without first trying to push it, and
   if the push fails keep the checkout and destroy the container anyway. The
   container is disposable and cheap to recreate; the work is neither, and boot
   salvage is the one retry for every reason. */
export async function teardown(
  sessionId: string,
  reason: TeardownReason,
): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  if (entry.busy > 0 && reason === "idle") {
    armIdleTimer(sessionId, entry);
    return;
  }
  const { workspace, options } = entry;
  let saved = true;
  try {
    if (await isDirty(workspace.dir)) {
      await commitAll(
        workspace.dir,
        `nightwarden: checkpoint at sandbox teardown (${reason})`,
        options.commitAuthor,
      );
    }
    if (await hasUnpushedWork(workspace.dir)) {
      await push(workspace.dir, workspace.branch, await options.authHeader());
    }
  } catch (err) {
    saved = false;
    options.log?.warn(
      {
        sessionId,
        reason,
        err: err instanceof Error ? err.message : String(err),
      },
      "sandbox teardown: work could not be pushed, keeping the checkout for boot salvage",
    );
  }
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
  sessions.delete(sessionId);
  await destroyContainer(entry.containerId).catch(() => undefined);
  if (saved) {
    await rm(workspace.dir, { recursive: true, force: true });
    await rm(homeDirFor(workspace.dir), { recursive: true, force: true });
  }
  options.log?.info({ sessionId, reason, saved }, "sandbox torn down");
}

export async function teardownAll(reason: TeardownReason): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => teardown(id, reason)));
}

/* Shutdown keeps every checkout and only stops the containers, which is the same
   rule reached from the other side: nothing is being dropped, so nothing needs
   pushing. Containers cannot outlive the process that started them, and the git
   work belongs to the next boot's salvage, which has time for it. */
export async function releaseContainers(): Promise<void> {
  const entries = [...sessions.values()];
  sessions.clear();
  await Promise.all(
    entries.map((entry) => {
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
      return destroyContainer(entry.containerId).catch(() => undefined);
    }),
  );
}
