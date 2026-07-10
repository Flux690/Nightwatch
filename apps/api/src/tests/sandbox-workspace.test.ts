import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { execFileMock, MockDocker } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  MockDocker: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("dockerode", () => ({ default: MockDocker }));

import {
  teardownAll,
  withWorkspace,
  type Workspace,
  type WorkspaceOptions,
} from "../sandbox/workspace.js";
import { reapOrphans, resetIsolationCache } from "../sandbox/docker.js";
import { preflight } from "../sandbox/preflight.js";
import { resolveRepoPath, assertContained } from "../sandbox/paths.js";
import { capOutput } from "../sandbox/output.js";
import {
  GitOperationError,
  PathEscapeError,
  SandboxUnavailableError,
} from "../sandbox/errors.js";
import { waitFor } from "./wait.js";

const AUTH_HEADER = "Basic c2VjcmV0dG9rZW4=";

// Scriptable git double honouring the execFile callback contract exactly:
// (error, stdout, stderr), options argument optional. Clone materializes
// cloneFiles plus .git/info, matching what a real clone puts on disk.
const gitState = {
  remoteBranchExists: false,
  dirty: false,
  unpushed: "0",
  failPush: false,
  calls: [] as string[][],
  cloneFiles: {} as Record<string, string>,
};

type ExecCb = (error: Error | null, stdout: string, stderr: string) => void;

function installGitMock(): void {
  execFileMock.mockImplementation((...fnArgs: unknown[]) => {
    // execFile(file, args, options?, callback) - normalize the optional options.
    const args = fnArgs[1] as string[];
    const cb = fnArgs[fnArgs.length - 1] as ExecCb;
    const stripped = [...args];
    while (stripped[0] === "-c") stripped.splice(0, 2);
    const sub = stripped[0] ?? "";
    gitState.calls.push(args);
    const ok = (stdout = ""): void => cb(null, stdout, "");
    const fail = (msg: string): void => cb(new Error(msg), "", msg);
    switch (sub) {
      case "--version":
        return ok("git version 2.44.0");
      case "clone": {
        const dir = stripped[stripped.length - 1]!;
        mkdirSync(join(dir, ".git", "info"), { recursive: true });
        for (const [rel, content] of Object.entries(gitState.cloneFiles)) {
          mkdirSync(join(dir, rel, ".."), { recursive: true });
          writeFileSync(join(dir, rel), content);
        }
        return ok();
      }
      case "rev-parse":
        return gitState.remoteBranchExists
          ? ok("abc123\n")
          : fail("fatal: Needed a single revision");
      case "checkout":
        return ok();
      case "status":
        return ok(gitState.dirty ? " M src/app.ts\n" : "");
      case "add":
        return ok();
      case "commit":
        gitState.dirty = false;
        gitState.unpushed = "1";
        return ok();
      case "rev-list":
        return ok(`${gitState.unpushed}\n`);
      case "push": {
        if (gitState.failPush) {
          const header = args
            .find((a) => a.startsWith("http.extraHeader="))
            ?.slice("http.extraHeader=".length);
          return fail(
            `fatal: unable to access repo: 403 (sent ${header ?? "no header"})`,
          );
        }
        gitState.unpushed = "0";
        return ok();
      }
      default:
        return ok();
    }
  });
}

const dockerState = {
  createArgs: [] as Array<Record<string, unknown>>,
  removed: [] as string[],
  listResult: [] as Array<{ Id: string }>,
  // exec:<command> and disconnect:<network> entries in arrival order, so tests
  // can prove the install ran before the network came off.
  events: [] as string[],
  execHandler: ((_command: string) => ({ exitCode: 0, output: "ok\n" })) as (
    command: string,
  ) => { exitCode: number; output: string },
  // containerId -> attached networks; every container starts on the bridge.
  networks: {} as Record<string, Record<string, unknown>>,
  disconnectNoop: false,
  pingFails: false,
  gvisor: false,
  nextId: 1,
};

function execEvents(): string[] {
  return dockerState.events
    .filter((e) => e.startsWith("exec:"))
    .map((e) => e.slice("exec:".length));
}

// Minimal stream honouring the contract execInContainer relies on: data
// chunks, then end. Raw (non-multiplexed) output exercises demux passthrough.
function fakeStream(output: string): {
  on: (event: string, cb: (chunk?: Buffer) => void) => void;
} {
  return {
    on(event, cb) {
      if (event === "data" && output.length > 0) cb(Buffer.from(output));
      if (event === "end") cb();
    },
  };
}

function installDockerMock(): void {
  // A function expression, not an arrow: getDocker() constructs with `new`,
  // and a constructor returning an object yields that object.
  MockDocker.mockImplementation(function () {
    return dockerFake();
  });
}

function dockerFake(): Record<string, unknown> {
  return {
    ping: () =>
      dockerState.pingFails
        ? Promise.reject(new Error("connect ENOENT /var/run/docker.sock"))
        : Promise.resolve({}),
    info: () =>
      Promise.resolve({
        Runtimes: dockerState.gvisor ? { runc: {}, runsc: {} } : { runc: {} },
      }),
    getImage: () => ({ inspect: () => Promise.resolve({}) }),
    createContainer: (opts: Record<string, unknown>) => {
      dockerState.createArgs.push(opts);
      const id = `container-${dockerState.nextId++}`;
      dockerState.networks[id] = { bridge: {} };
      return Promise.resolve({ id, start: () => Promise.resolve() });
    },
    getContainer: (id: string) => ({
      remove: () => {
        dockerState.removed.push(id);
        return Promise.resolve();
      },
      inspect: () =>
        Promise.resolve({
          NetworkSettings: { Networks: { ...dockerState.networks[id] } },
        }),
      exec: (opts: { Cmd: string[] }) => {
        const command = opts.Cmd[4] ?? "";
        dockerState.events.push(`exec:${command}`);
        const result = dockerState.execHandler(command);
        return Promise.resolve({
          start: () => Promise.resolve(fakeStream(result.output)),
          inspect: () => Promise.resolve({ ExitCode: result.exitCode }),
        });
      },
    }),
    listContainers: () => Promise.resolve(dockerState.listResult),
    getNetwork: (name: string) => ({
      disconnect: (opts: { Container: string }) => {
        dockerState.events.push(`disconnect:${name}`);
        if (!dockerState.disconnectNoop) {
          delete dockerState.networks[opts.Container]?.[name];
        }
        return Promise.resolve();
      },
    }),
  };
}

let workspacesDir: string;
let sessionCounter = 0;

function options(overrides?: Partial<WorkspaceOptions>): WorkspaceOptions {
  return {
    cloneUrl: "https://github.com/acme/api.git",
    branch: "nightwatch/fix-oom-12345678",
    authHeader: () => Promise.resolve(AUTH_HEADER),
    limits: { cpus: 2, memoryMb: 4096 },
    idleTimeoutMs: 60_000,
    workspacesDir,
    requireGvisor: false,
    network: "none",
    commitAuthor: { name: "Nightwatch", email: "noreply@nightwatch.local" },
    pullRequests: {
      create: () => Promise.resolve({ number: 1, url: "", draft: true }),
      findOpenByBranch: () => Promise.resolve(null),
      update: () => Promise.resolve(),
    },
    ...overrides,
  };
}

function nextSessionId(): string {
  sessionCounter++;
  return `00000000-0000-4000-8000-${String(sessionCounter).padStart(12, "0")}`;
}

beforeAll(() => {
  workspacesDir = mkdtempSync(join(tmpdir(), "nw-sandbox-"));
  installGitMock();
  installDockerMock();
});

afterAll(() => {
  rmSync(workspacesDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

afterEach(async () => {
  vi.useRealTimers();
  gitState.failPush = false;
  await teardownAll("test cleanup");
  gitState.remoteBranchExists = false;
  gitState.dirty = false;
  gitState.unpushed = "0";
  gitState.calls = [];
  gitState.cloneFiles = {};
  dockerState.createArgs = [];
  dockerState.removed = [];
  dockerState.listResult = [];
  dockerState.events = [];
  dockerState.execHandler = () => ({ exitCode: 0, output: "ok\n" });
  dockerState.networks = {};
  dockerState.disconnectNoop = false;
  dockerState.pingFails = false;
  dockerState.gvisor = false;
  resetIsolationCache();
});

function cloneCalls(): string[][] {
  return gitState.calls.filter((args) => args.includes("clone"));
}

describe("workspace lifecycle", () => {
  it("creates lazily: clone with per-invocation auth lands before the tool body runs, in a hardened container", async () => {
    const sessionId = nextSessionId();
    await withWorkspace(sessionId, options(), (ws) => {
      // Both the checkout and the container exist before any tool code runs.
      expect(cloneCalls()).toHaveLength(1);
      expect(dockerState.createArgs).toHaveLength(1);
      expect(ws.dir).toBe(join(workspacesDir, sessionId));
      expect(ws.branch).toBe("nightwatch/fix-oom-12345678");
      return Promise.resolve(undefined);
    });

    const clone = cloneCalls()[0]!;
    expect(clone[0]).toBe("-c");
    expect(clone[1]).toBe(`http.extraHeader=Authorization: ${AUTH_HEADER}`);
    expect(clone).toContain("https://github.com/acme/api.git");

    const create = dockerState.createArgs[0]!;
    expect(create["Image"]).toBe("node:24");
    // HOME rides its own mount so package-manager caches never land inside
    // the checkout (git add -A would sweep them into checkpoint commits).
    expect(create["Env"]).toContain("HOME=/home/sandbox");
    expect(create["Env"]).toContain("COREPACK_ENABLE_DOWNLOAD_PROMPT=0");
    expect(create["Labels"]).toMatchObject({
      "nightwatch.sandbox": "1",
      "nightwatch.session": sessionId,
    });
    const host = create["HostConfig"] as Record<string, unknown>;
    expect(host["ReadonlyRootfs"]).toBe(true);
    expect(host["CapDrop"]).toEqual(["ALL"]);
    expect(host["SecurityOpt"]).toEqual(["no-new-privileges"]);
    expect(host["NanoCpus"]).toBe(2_000_000_000);
    expect(host["Memory"]).toBe(4096 * 1024 * 1024);
    expect(host["Binds"]).toEqual([
      `${join(workspacesDir, sessionId)}:/workspace`,
      `${join(workspacesDir, sessionId)}.home:/home/sandbox`,
    ]);
    // Wall reinforcements: real memory cap (swap == memory), fork-bomb and fd
    // limits, non-root ownership-matched user, no-dev tmpfs.
    expect(host["MemorySwap"]).toBe(4096 * 1024 * 1024);
    expect(host["PidsLimit"]).toBe(512);
    expect(host["Ulimits"]).toEqual([
      { Name: "nofile", Soft: 4096, Hard: 4096 },
    ]);
    expect(host["Tmpfs"]).toEqual({ "/tmp": "rw,exec,nosuid,nodev,size=1g" });
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid !== undefined && gid !== undefined) {
      expect(create["User"]).toBe(`${uid}:${gid}`);
    }
    // Standard host advertises no runsc runtime: no Runtime override.
    expect(host["Runtime"]).toBeUndefined();
  });

  it("runs under the gVisor runtime when the host advertises runsc", async () => {
    dockerState.gvisor = true;
    const sessionId = nextSessionId();
    await withWorkspace(sessionId, options(), () => Promise.resolve());
    const host = dockerState.createArgs[0]!["HostConfig"] as Record<
      string,
      unknown
    >;
    expect(host["Runtime"]).toBe("runsc");
  });

  it("refuses to create a sandbox when requireGvisor is on but the host lacks it", async () => {
    dockerState.gvisor = false;
    const sessionId = nextSessionId();
    await expect(
      withWorkspace(sessionId, options({ requireGvisor: true }), () =>
        Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(dockerState.createArgs).toHaveLength(0);
  });

  it("reuses the live workspace across calls in a burst", async () => {
    const sessionId = nextSessionId();
    await withWorkspace(sessionId, options(), () => Promise.resolve());
    await withWorkspace(sessionId, options(), () => Promise.resolve());
    expect(cloneCalls()).toHaveLength(1);
    expect(dockerState.createArgs).toHaveLength(1);
  });

  it("tears down after the idle timeout without pushing when nothing changed, and a resume re-clones the same branch", async () => {
    vi.useFakeTimers();
    const sessionId = nextSessionId();
    await withWorkspace(sessionId, options(), () => Promise.resolve());
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    await waitFor(() => !existsSync(join(workspacesDir, sessionId)));
    // The sibling HOME mount dies with the workspace.
    expect(existsSync(join(workspacesDir, `${sessionId}.home`))).toBe(false);
    expect(dockerState.removed).toHaveLength(1);
    expect(gitState.calls.some((a) => a.includes("push"))).toBe(false);

    // Resume: same branch, found on the remote now.
    gitState.remoteBranchExists = true;
    await withWorkspace(sessionId, options(), () => Promise.resolve());
    expect(cloneCalls()).toHaveLength(2);
    const checkout = gitState.calls
      .filter((a) => a.includes("checkout"))
      .at(-1);
    expect(checkout).toEqual([
      "checkout",
      "-B",
      "nightwatch/fix-oom-12345678",
      "origin/nightwatch/fix-oom-12345678",
    ]);
  });

  it("checkpoint-commits and pushes dirty work at idle teardown", async () => {
    vi.useFakeTimers();
    const sessionId = nextSessionId();
    await withWorkspace(sessionId, options(), () => {
      gitState.dirty = true;
      return Promise.resolve();
    });
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    await waitFor(() => dockerState.removed.length === 1);
    expect(gitState.calls.some((a) => a.includes("commit"))).toBe(true);
    const push = gitState.calls.find((a) => a.includes("push"));
    expect(push).toBeDefined();
    expect(push).toContain("nightwatch/fix-oom-12345678");
    expect(push?.[1]).toBe(`http.extraHeader=Authorization: ${AUTH_HEADER}`);
  });

  it("aborts idle teardown when the push fails, keeping container and workspace", async () => {
    const warn = vi.fn();
    vi.useFakeTimers();
    const sessionId = nextSessionId();
    await withWorkspace(
      sessionId,
      options({
        log: { info: vi.fn(), warn },
      }),
      () => {
        gitState.dirty = true;
        gitState.failPush = true;
        return Promise.resolve();
      },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    await waitFor(() => warn.mock.calls.length > 0);
    expect(dockerState.removed).toHaveLength(0);
    expect(existsSync(join(workspacesDir, sessionId))).toBe(true);
    // The live entry is retained: the next call needs no fresh clone.
    await withWorkspace(sessionId, options(), () => Promise.resolve());
    expect(cloneCalls()).toHaveLength(1);
  });

  it("never lets the auth header reach a git error message", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const sessionId = nextSessionId();
    await withWorkspace(
      sessionId,
      options({ log: { info: vi.fn(), warn } }),
      () => {
        gitState.dirty = true;
        gitState.failPush = true;
        return Promise.resolve();
      },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    const logged = await waitFor(() => warn.mock.calls[0]);
    const fields = logged[0] as { err: string };
    expect(fields.err).toContain("[REDACTED]");
    expect(fields.err).not.toContain(AUTH_HEADER);
    expect(fields.err).toContain("git push failed");
  });

  it("reapOrphans removes every labeled container", async () => {
    dockerState.listResult = [{ Id: "orphan-1" }, { Id: "orphan-2" }];
    const reaped = await reapOrphans();
    expect(reaped).toBe(2);
    expect(dockerState.removed).toEqual(["orphan-1", "orphan-2"]);
  });
});

describe("networkless two-phase setup", () => {
  const PKG = '{ "name": "fixture" }\n';

  async function createWorkspace(
    overrides?: Partial<WorkspaceOptions>,
  ): Promise<Workspace> {
    const sessionId = nextSessionId();
    let captured: Workspace | undefined;
    await withWorkspace(sessionId, options(overrides), (ws) => {
      captured = ws;
      return Promise.resolve();
    });
    return captured!;
  }

  // One row per INSTALL_RULES entry: the lockfile (or corepack field) picks
  // the frozen command. Keep in lockstep with sandbox/install.ts.
  it.each([
    ["pnpm-lock.yaml", PKG, "corepack pnpm install --frozen-lockfile"],
    ["yarn.lock", PKG, "yarn install --frozen-lockfile"],
    [
      "yarn.lock",
      '{ "name": "fixture", "packageManager": "yarn@4.5.0" }\n',
      "corepack yarn install --immutable",
    ],
    ["package-lock.json", PKG, "npm ci"],
  ])(
    "installs from %s with the frozen command, then detaches the network",
    async (lockfile, pkg, frozen) => {
      gitState.cloneFiles = { "package.json": pkg, [lockfile]: "x\n" };
      const ws = await createWorkspace();

      expect(execEvents()).toEqual([frozen]);
      expect(ws.setup).toMatchObject({ command: frozen, exitCode: 0 });
      expect(ws.setup?.frozen).toBe(true);
      // The install ran while the network was up; detachment came after.
      const installAt = dockerState.events.indexOf(`exec:${frozen}`);
      const disconnectAt = dockerState.events.indexOf("disconnect:bridge");
      expect(disconnectAt).toBeGreaterThan(installAt);
      expect(
        dockerState.networks[`container-${dockerState.nextId - 1}`],
      ).toEqual({});
    },
  );

  it("falls back to the relaxed install when the frozen rung fails, and says so", async () => {
    gitState.cloneFiles = { "package.json": PKG, "pnpm-lock.yaml": "x\n" };
    dockerState.execHandler = (command) =>
      command.includes("--frozen-lockfile")
        ? { exitCode: 1, output: "ERR_PNPM_OUTDATED_LOCKFILE\n" }
        : { exitCode: 0, output: "done\n" };

    const ws = await createWorkspace();
    expect(execEvents()).toEqual([
      "corepack pnpm install --frozen-lockfile",
      "corepack pnpm install",
    ]);
    expect(ws.setup).toMatchObject({
      command: "corepack pnpm install",
      exitCode: 0,
      frozen: false,
    });
  });

  it("a repo with no lockfile gets the best-effort install", async () => {
    gitState.cloneFiles = { "package.json": PKG };
    const ws = await createWorkspace();
    expect(execEvents()).toEqual(["npm install"]);
    expect(ws.setup?.frozen).toBe(false);
  });

  it("a repo with no package.json installs nothing and still detaches", async () => {
    const ws = await createWorkspace();
    expect(execEvents()).toEqual([]);
    expect(ws.setup).toBeNull();
    expect(dockerState.events).toContain("disconnect:bridge");
  });

  it("a failed install is survivable: recorded, warned, workspace still usable", async () => {
    const warn = vi.fn();
    gitState.cloneFiles = { "package.json": PKG, "package-lock.json": "x\n" };
    dockerState.execHandler = () => ({ exitCode: 1, output: "EAI_AGAIN\n" });

    const ws = await createWorkspace({ log: { info: vi.fn(), warn } });
    // Both rungs were tried; the failure is on the workspace for every
    // consumer (exec note, verification honest-absence).
    expect(execEvents()).toEqual(["npm ci", "npm install"]);
    expect(ws.setup).toMatchObject({ command: "npm install", exitCode: 1 });
    expect(ws.setup?.outputTail).toContain("EAI_AGAIN");
    expect(
      warn.mock.calls.some((args) =>
        String(args[1]).includes("dependency install failed"),
      ),
    ).toBe(true);
    // The network still came off - a broken install never leaves egress open.
    expect(dockerState.events).toContain("disconnect:bridge");
  });

  it("open mode skips detachment and keeps the bridge attached", async () => {
    gitState.cloneFiles = { "package.json": PKG };
    await createWorkspace({ network: "open" });
    expect(execEvents()).toEqual(["npm install"]);
    expect(dockerState.events).not.toContain("disconnect:bridge");
    expect(
      dockerState.networks[`container-${dockerState.nextId - 1}`],
    ).toHaveProperty("bridge");
  });

  it("fails loud and destroys the container when detachment does not stick", async () => {
    dockerState.disconnectNoop = true;
    const sessionId = nextSessionId();
    await expect(
      withWorkspace(sessionId, options(), () => Promise.resolve()),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(dockerState.removed).toHaveLength(1);
    expect(existsSync(join(workspacesDir, sessionId))).toBe(false);
  });

  it("locally excludes node_modules so a repo without .gitignore never commits it", async () => {
    gitState.cloneFiles = { "package.json": PKG };
    const ws = await createWorkspace();
    expect(
      readFileSync(join(ws.dir, ".git", "info", "exclude"), "utf8"),
    ).toContain("node_modules/");
  });
});

describe("preflight", () => {
  it("passes when git and the docker daemon respond, reporting the isolation mode", async () => {
    await expect(preflight()).resolves.toEqual({
      ok: true,
      isolation: "standard",
    });
  });

  it("reports gvisor isolation when the host advertises runsc", async () => {
    dockerState.gvisor = true;
    await expect(preflight()).resolves.toEqual({
      ok: true,
      isolation: "gvisor",
    });
  });

  it("reports an unreachable docker daemon", async () => {
    dockerState.pingFails = true;
    const result = await preflight();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Docker daemon is not reachable");
  });
});

describe("path containment", () => {
  const ws = "/work/space";

  it("resolves clean repo-relative paths", () => {
    expect(resolveRepoPath(ws, "src/app.ts")).toBe("/work/space/src/app.ts");
    expect(resolveRepoPath(ws, "./src/app.ts")).toBe("/work/space/src/app.ts");
    expect(resolveRepoPath(ws, "a/b/../c.txt")).toBe("/work/space/a/c.txt");
  });

  it.each(["../evil", "/etc/passwd", "a/../../evil", "..", "", "a\0b"])(
    "rejects escaping path %j",
    (p) => {
      expect(() => resolveRepoPath(ws, p)).toThrow(PathEscapeError);
    },
  );

  it("rejects a symlink that points outside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "nw-paths-"));
    try {
      const inside = join(root, "workspace");
      mkdirSync(inside);
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "secret");
      symlinkSync(outside, join(inside, "link.txt"));

      await expect(
        assertContained(inside, join(inside, "link.txt")),
      ).rejects.toThrow(PathEscapeError);
      // A not-yet-existing file under the workspace is fine (write path).
      await expect(
        assertContained(inside, join(inside, "new/file.txt")),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("output capping", () => {
  it("returns short output untouched", () => {
    expect(capOutput("hello")).toEqual({ text: "hello", truncated: false });
  });

  it("elides the middle of oversized output on UTF-8 boundaries", () => {
    const big = "é".repeat(50_000); // 100k bytes of two-byte chars
    const capped = capOutput(big);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toContain("bytes elided");
    expect(capped.text).not.toContain("�");
    expect(Buffer.byteLength(capped.text, "utf8")).toBeLessThan(70_000);
  });
});

describe("errors", () => {
  it("GitOperationError carries a redacted message", () => {
    const err = new GitOperationError("git push failed: boom");
    expect(err.name).toBe("GitOperationError");
  });
});
