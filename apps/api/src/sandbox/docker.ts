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

export async function createSandboxContainer(opts: {
  sessionId: string;
  workspaceDir: string;
  limits: SandboxLimits;
}): Promise<string> {
  await ensureImage();
  const docker = getDocker();
  const container = await docker.createContainer({
    Image: SANDBOX_IMAGE,
    name: `nightwatch-sandbox-${opts.sessionId}`,
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/workspace",
    // npm/pnpm need a writable HOME and tmp or the very first install fails;
    // the workspace is the only writable mount, so HOME lives there.
    Env: ["HOME=/workspace"],
    Labels: { [SANDBOX_LABEL]: "1", [SESSION_LABEL]: opts.sessionId },
    HostConfig: {
      Binds: [`${opts.workspaceDir}:/workspace`],
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/tmp": "rw,exec,nosuid,size=1g" },
      NanoCpus: Math.round(opts.limits.cpus * 1e9),
      Memory: opts.limits.memoryMb * 1024 * 1024,
    },
  });
  await container.start();
  return container.id;
}

// Docker multiplexes stdout/stderr into 8-byte-framed chunks when the exec
// has no TTY; frames are concatenated in arrival order so the combined output
// reads the way a terminal would show it.
function demuxOutput(buf: Buffer): string {
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
