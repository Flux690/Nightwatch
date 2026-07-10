import Dockerode from "dockerode";
import { SandboxUnavailableError } from "./errors.js";

export const SANDBOX_LABEL = "nightwatch.sandbox";
export const SESSION_LABEL = "nightwatch.session";
export const SANDBOX_IMAGE = "node:24";

// Per-operation factory, mirroring the runner's docker client: no long-lived
// singleton to go stale across daemon restarts.
export function getDocker(): Dockerode {
  return new Dockerode();
}

export async function pingDocker(): Promise<void> {
  try {
    await getDocker().ping();
  } catch {
    throw new SandboxUnavailableError(
      "Docker daemon is not reachable on the API host",
    );
  }
}

export type Isolation = "gvisor" | "standard";

// Whether the Docker host advertises the gVisor (runsc) runtime. Cached per
// boot: runtimes don't change under a running daemon, and every sandbox
// creation would otherwise pay an info() round-trip.
let cachedIsolation: Isolation | undefined;

export async function detectIsolation(): Promise<Isolation> {
  if (cachedIsolation !== undefined) return cachedIsolation;
  try {
    const info = (await getDocker().info()) as {
      Runtimes?: Record<string, unknown>;
    };
    cachedIsolation =
      info.Runtimes !== undefined && "runsc" in info.Runtimes
        ? "gvisor"
        : "standard";
  } catch {
    cachedIsolation = "standard";
  }
  return cachedIsolation;
}

// The isolation probe is memoized for the process; tests that vary the host's
// advertised runtimes reset it, the same support `resetDb` provides.
export function resetIsolationCache(): void {
  cachedIsolation = undefined;
}

export async function ensureImage(): Promise<void> {
  const docker = getDocker();
  try {
    await docker.getImage(SANDBOX_IMAGE).inspect();
    return;
  } catch {
    // Missing locally - pull below and wait for completion.
  }
  const stream = await docker.pull(SANDBOX_IMAGE);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", () => undefined);
    stream.on("end", resolve);
    stream.on("error", reject);
  });
}

export interface SandboxLimits {
  cpus: number;
  memoryMb: number;
}

// Run as the API's own uid:gid so workspace files match the host-side clone's
// owner (no chown friction); non-root whenever the API is. undefined where
// getuid is absent, keeping the image default.
function processUser(): string | undefined {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  if (uid === null || gid === null) return undefined;
  return `${uid}:${gid}`;
}

export function apiRunsAsRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

// Host-injected egress wiring: enforcing puts the sandbox on the Internal
// network behind the proxy (no direct outbound); open keeps the default
// bridge. The sandbox never reads config - the host decides.
export interface EgressWiring {
  networkName: string;
  proxyUrl: string;
}

export async function createSandboxContainer(opts: {
  sessionId: string;
  workspaceDir: string;
  limits: SandboxLimits;
  requireGvisor: boolean;
  egress?: EgressWiring;
}): Promise<string> {
  await ensureImage();
  const isolation = await detectIsolation();
  if (opts.requireGvisor && isolation !== "gvisor") {
    throw new SandboxUnavailableError(
      "sandboxRequireGvisor is on but the Docker host has no gVisor (runsc) runtime",
    );
  }
  const memoryBytes = opts.limits.memoryMb * 1024 * 1024;
  const user = processUser();
  const proxyEnv =
    opts.egress === undefined
      ? []
      : [
          `HTTP_PROXY=${opts.egress.proxyUrl}`,
          `HTTPS_PROXY=${opts.egress.proxyUrl}`,
          `http_proxy=${opts.egress.proxyUrl}`,
          `https_proxy=${opts.egress.proxyUrl}`,
          "NO_PROXY=localhost,127.0.0.1",
        ];
  const docker = getDocker();
  const container = await docker.createContainer({
    Image: SANDBOX_IMAGE,
    name: `nightwatch-sandbox-${opts.sessionId}`,
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/workspace",
    // npm/pnpm need a writable HOME and tmp or the very first install fails;
    // the workspace is the only writable mount, so HOME lives there.
    Env: ["HOME=/workspace", ...proxyEnv],
    Labels: { [SANDBOX_LABEL]: "1", [SESSION_LABEL]: opts.sessionId },
    ...(user !== undefined && { User: user }),
    HostConfig: {
      Binds: [`${opts.workspaceDir}:/workspace`],
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/tmp": "rw,exec,nosuid,nodev,size=1g" },
      NanoCpus: Math.round(opts.limits.cpus * 1e9),
      Memory: memoryBytes,
      // Equal to Memory so the cap is real: an unset swap limit lets Docker
      // grant up to 2x the memory via swap.
      MemorySwap: memoryBytes,
      // Fork-bomb and fd-exhaustion caps: a runaway command can wedge itself
      // but not the API host.
      PidsLimit: 512,
      Ulimits: [{ Name: "nofile", Soft: 4096, Hard: 4096 }],
      // gVisor when the host has it; the hardened runc container otherwise.
      ...(isolation === "gvisor" && { Runtime: "runsc" }),
      // Enforcing egress means the Internal network is the sandbox's ONLY
      // interface: no route to the internet except through the proxy.
      ...(opts.egress !== undefined && {
        NetworkMode: opts.egress.networkName,
      }),
    },
  });
  await container.start();
  return container.id;
}

// Docker multiplexes stdout/stderr into 8-byte-framed chunks when the exec
// has no TTY; frames are concatenated in arrival order so the combined output
// reads the way a terminal would show it.
export function demuxOutput(buf: Buffer): string {
  if (buf.length === 0) return "";
  const first = buf[0] ?? 0;
  if (first !== 0 && first !== 1 && first !== 2) return buf.toString("utf8");
  let out = "";
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    out += buf.subarray(offset + 8, offset + 8 + size).toString("utf8");
    offset += 8 + size;
  }
  return out;
}

export interface ContainerExecResult {
  exitCode: number;
  output: string;
}

// `timeout` (coreutils, present in node:24) enforces the deadline inside the
// container - exit 124 marks expiry; a JS-side backstop guards a hung daemon.
export async function execInContainer(
  containerId: string,
  command: string,
  opts: { cwd?: string; timeoutMs: number },
): Promise<ContainerExecResult> {
  const container = getDocker().getContainer(containerId);
  const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  const exec = await container.exec({
    Cmd: ["timeout", String(seconds), "sh", "-lc", command],
    AttachStdout: true,
    AttachStderr: true,
    ...(opts.cwd !== undefined && { WorkingDir: opts.cwd }),
  });
  const stream = await exec.start({});
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const backstop = setTimeout(() => {
      reject(new SandboxUnavailableError("container exec did not settle"));
    }, opts.timeoutMs + 30_000);
    backstop.unref();
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      clearTimeout(backstop);
      resolve();
    });
    stream.on("error", (err) => {
      clearTimeout(backstop);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
  const info = await exec.inspect();
  return {
    exitCode: info.ExitCode ?? 0,
    output: demuxOutput(Buffer.concat(chunks)),
  };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { statusCode?: number }).statusCode === 404
  );
}

export async function destroyContainer(containerId: string): Promise<void> {
  try {
    await getDocker().getContainer(containerId).remove({ force: true });
  } catch (err) {
    // 404 means already gone (manual rm, daemon restart) - the desired state.
    if (!isNotFound(err)) throw err;
  }
}

// Boot-time sweep: the session map is memory-only, so after a restart every
// labeled container is an orphan by definition - derive, don't cache.
export async function reapOrphans(): Promise<number> {
  const docker = getDocker();
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${SANDBOX_LABEL}=1`] }),
  });
  await Promise.all(
    containers.map((c) =>
      docker
        .getContainer(c.Id)
        .remove({ force: true })
        .catch(() => undefined),
    ),
  );
  return containers.length;
}
