import type Dockerode from "dockerode";
import {
  deriveDockerServiceIdentity,
  serviceIdentityKey,
  type DockerBashInput,
  type DockerBashResult,
  type DockerConfigInput,
  type DockerConfigResult,
  type DockerEvent,
  type DockerEventsInput,
  type DockerEventsResult,
  type DockerLogsInput,
  type DockerLogsResult,
  type DockerProcess,
  type DockerProcessesInput,
  type DockerProcessesResult,
  type DockerRestartInput,
  type DockerRestartResult,
  type DockerServiceListResult,
  type DockerStatsInput,
  type DockerStatsResult,
  type NotFoundResult,
} from "@nightwarden/shared";
import { getDocker, listVisibleContainers, parseDockerMux } from "./client.js";
import { noContainerResult, resolveService } from "./resolve-service.js";
import { sanitizeExecOutput } from "../safety/allowlist.js";

// Takes no input: a Docker runner is 1:1 with its host, so there is nothing to
// scope the listing by.
export async function getContainerList(): Promise<DockerServiceListResult> {
  const docker = getDocker();
  const raw = await listVisibleContainers(docker);
  const containers = raw.map((c) => {
    const status = c.Status;
    const image = c.Image;
    const name = (c.Names[0] ?? "").replace(/^\//, "");
    // Keys exactly as the manifest advertises it (detect.ts), so a discovered
    // target resolves back to the entry it came from.
    const identity = deriveDockerServiceIdentity(c.Labels, name);
    return {
      name,
      id: c.Id.slice(0, 12),
      target: serviceIdentityKey(identity),
      image,
      imageTag: image.includes(":")
        ? (image.split(":")[1] ?? "latest")
        : "latest",
      status,
      restartCount: 0,
      uptimeSeconds: parseUptime(status),
      healthStatus: status.includes("(healthy)")
        ? "healthy"
        : status.includes("(unhealthy)")
          ? "unhealthy"
          : "unknown",
    };
  });
  return { containers };
}

export async function getContainerLogs(
  input: DockerLogsInput,
): Promise<DockerLogsResult | NotFoundResult> {
  const docker = getDocker();
  const resolved = await resolveService(docker, input.service);
  if (!resolved) return noContainerResult(input.service);
  const container = resolved.container;

  const since = input.sinceTimestamp
    ? Math.floor(new Date(input.sinceTimestamp).getTime() / 1000)
    : undefined;

  const buf = await container.logs({
    stdout: !input.stderrOnly,
    stderr: true,
    follow: false,
    tail: input.tailLines ?? 200,
    ...(since !== undefined && { since }),
  });

  const { stdout, stderr } = parseDockerMux(buf);
  const allLines = (stdout + stderr).split("\n").filter(Boolean);

  const ERROR_RE =
    /\b(error|err|warn|warning|fatal|exception|traceback|panic)\b/i;
  const alertTs = input.sinceTimestamp
    ? new Date(input.sinceTimestamp).getTime()
    : null;

  const filtered = allLines.filter((line) => {
    if (ERROR_RE.test(line)) return true;
    if (alertTs) {
      const ts = extractLineTimestamp(line);
      if (ts !== null && Math.abs(ts - alertTs) <= 30_000) return true;
    }
    return false;
  });

  return {
    lines: filtered,
    totalLines: allLines.length,
    droppedLines: allLines.length - filtered.length,
    compressionNote:
      filtered.length === allLines.length
        ? ""
        : `Filtered to ${filtered.length} of ${allLines.length} lines (errors, warnings, lines near alert timestamp)`,
  };
}

export async function getContainerInspect(
  input: DockerConfigInput,
): Promise<DockerConfigResult | NotFoundResult> {
  const docker = getDocker();
  const resolved = await resolveService(docker, input.service);
  if (!resolved) return noContainerResult(input.service);
  const raw = await resolved.container.inspect();

  const envVarNames = (raw.Config.Env ?? []).map((e) => e.split("=")[0] ?? e);

  return {
    name: raw.Name.replace(/^\//, ""),
    image: raw.Config.Image,
    imageDigest: raw.Image,
    envVarNames,
    mounts: raw.Mounts,
    ports: Object.keys(raw.NetworkSettings.Ports ?? {}),
    restartPolicy: raw.HostConfig.RestartPolicy?.Name ?? "no",
    healthCheck: {
      test: raw.Config.Healthcheck?.Test ?? [],
      interval: (raw.Config.Healthcheck?.Interval ?? 0) / 1e9,
      retries: raw.Config.Healthcheck?.Retries ?? 0,
      lastResult: raw.State.Health?.Status ?? "none",
    },
    createdAt: raw.Created,
    startedAt: raw.State.StartedAt,
  };
}

export async function getContainerStats(
  input: DockerStatsInput,
): Promise<DockerStatsResult | NotFoundResult> {
  const docker = getDocker();
  const resolved = await resolveService(docker, input.service);
  if (!resolved || !resolved.live) return noContainerResult(input.service);
  const raw = await resolved.container.stats({ stream: false });

  const cpuDelta =
    raw.cpu_stats.cpu_usage.total_usage -
    raw.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    (raw.cpu_stats.system_cpu_usage ?? 0) -
    (raw.precpu_stats.system_cpu_usage ?? 0);
  const numCPUs =
    raw.cpu_stats.online_cpus ||
    raw.cpu_stats.cpu_usage.percpu_usage?.length ||
    1;
  const cpuPercent =
    systemDelta > 0 ? Math.max(0, (cpuDelta / systemDelta) * numCPUs * 100) : 0;

  const statsObj = raw.memory_stats.stats as Record<string, number> | undefined;
  const inactiveFile =
    statsObj?.["total_inactive_file"] ?? statsObj?.["inactive_file"] ?? 0;
  const memoryUsedBytes = (raw.memory_stats.usage ?? 0) - inactiveFile;
  const memoryLimitBytes = raw.memory_stats.limit ?? 0;
  const memoryPercent =
    memoryLimitBytes > 0 ? (memoryUsedBytes / memoryLimitBytes) * 100 : 0;

  let networkRxBytes = 0;
  let networkTxBytes = 0;
  for (const iface of Object.values(raw.networks ?? {})) {
    networkRxBytes += iface.rx_bytes ?? 0;
    networkTxBytes += iface.tx_bytes ?? 0;
  }

  let blockReadBytes = 0;
  let blockWriteBytes = 0;
  for (const entry of raw.blkio_stats?.io_service_bytes_recursive ?? []) {
    if (entry.op === "Read") blockReadBytes += entry.value;
    else if (entry.op === "Write") blockWriteBytes += entry.value;
  }

  return {
    cpuPercent,
    memoryUsedBytes,
    memoryLimitBytes,
    memoryPercent,
    networkRxBytes,
    networkTxBytes,
    blockReadBytes,
    blockWriteBytes,
    pids: raw.pids_stats?.current ?? 0,
  };
}

export async function getContainerEvents(
  input: DockerEventsInput,
): Promise<DockerEventsResult | NotFoundResult> {
  const docker = getDocker();
  const resolved = await resolveService(docker, input.service);
  if (!resolved) return noContainerResult(input.service);

  const now = Math.floor(Date.now() / 1000);
  const since = now - (input.sinceMinutes ?? 60) * 60;

  const stream = await docker.getEvents({
    since,
    until: now,
    filters: JSON.stringify({ container: [resolved.id] }),
  });

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const text = Buffer.concat(chunks).toString("utf8");
  const events: DockerEvent[] = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const data = JSON.parse(line) as Record<string, unknown>;
      const action = String(data["Action"] ?? "");
      const actor = data["Actor"] as Record<string, unknown> | undefined;
      return {
        timestamp: new Date(Number(data["time"]) * 1000).toISOString(),
        eventType: action,
        message: action,
        actor: String(actor?.["ID"] ?? "").slice(0, 12),
      };
    });

  return { events };
}

export async function getContainerProcesses(
  input: DockerProcessesInput,
): Promise<DockerProcessesResult | NotFoundResult> {
  const docker = getDocker();
  const resolved = await resolveService(docker, input.service);
  if (!resolved || !resolved.live) return noContainerResult(input.service);
  const top = (await resolved.container.top()) as {
    Titles: string[];
    Processes: string[][];
  };

  const titles = top.Titles ?? [];
  const uidIdx = titles.indexOf("UID");
  const pidIdx = titles.indexOf("PID");
  const ppidIdx = titles.indexOf("PPID");
  const cIdx = titles.indexOf("C");
  const cmdIdx = titles.indexOf("CMD");

  const processes: DockerProcess[] = (top.Processes ?? []).map((row) => ({
    pid: parseInt(row[pidIdx] ?? "0", 10),
    ppid: parseInt(row[ppidIdx] ?? "0", 10),
    user: row[uidIdx] ?? "unknown",
    cpuPercent: parseFloat(row[cIdx] ?? "0"),
    memPercent: 0,
    command: row[cmdIdx] ?? "",
  }));

  return { processes };
}

export async function restartContainer(
  input: DockerRestartInput,
): Promise<DockerRestartResult | NotFoundResult> {
  const startedAt = new Date().toISOString();
  const docker = getDocker();
  const resolved = await resolveService(docker, input.service);
  if (!resolved || !resolved.live) return noContainerResult(input.service);
  const container = resolved.container;

  const before = await container.inspect();
  const previousExitCode = before.State.ExitCode ?? 0;

  if (input.delaySeconds && input.delaySeconds > 0) {
    await new Promise((r) => setTimeout(r, input.delaySeconds! * 1000));
  }

  await container.restart();

  const newStatus = await waitForSettledStatus(container);

  return {
    success: newStatus === "running",
    startedAt,
    previousExitCode,
    newStatus,
  };
}

async function waitForSettledStatus(
  container: Dockerode.Container,
): Promise<string> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const info = await container.inspect();
    const status = info.State.Status ?? "unknown";
    if (
      status === "running" ||
      status === "exited" ||
      status === "dead" ||
      Date.now() >= deadline
    ) {
      return status;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function execCommand(
  input: DockerBashInput,
): Promise<DockerBashResult | NotFoundResult> {
  const executedAt = new Date().toISOString();
  const [cmd, ...args] = input.command;
  if (!cmd) throw new Error("command array must not be empty");

  const docker = getDocker();
  const resolved = await resolveService(docker, input.service);
  if (!resolved || !resolved.live) return noContainerResult(input.service);
  const container = resolved.container;

  const exec = await container.exec({
    Cmd: [cmd, ...args],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({});
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const raw = parseDockerMux(Buffer.concat(chunks));
  const info = await exec.inspect();

  return {
    exitCode: info.ExitCode ?? 0,
    stdout: sanitizeExecOutput(raw.stdout),
    stderr: sanitizeExecOutput(raw.stderr),
    executedAt,
  };
}

function parseUptime(status: string): number {
  const m = status.match(/Up\s+(\d+)\s+(second|minute|hour|day|week|month)/i);
  if (!m) return 0;
  const n = parseInt(m[1]!, 10);
  const multipliers: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3600,
    day: 86400,
    week: 604800,
    month: 2592000,
  };
  return n * (multipliers[m[2]!.toLowerCase()] ?? 1);
}

function extractLineTimestamp(line: string): number | null {
  const iso = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  if (iso) return new Date(iso[0]).getTime();
  return null;
}
