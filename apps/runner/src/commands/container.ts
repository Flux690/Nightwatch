import type {
  ContainerEvent,
  ContainerInfo,
  ContainerInspectResult,
  ContainerLogsResult,
  ContainerProcess,
  ContainerStatsResult,
  GetContainerEventsInput,
  GetContainerInspectInput,
  GetContainerListInput,
  GetContainerLogsInput,
  GetContainerProcessesInput,
  GetContainerStatsInput,
  GetEnvVariableNamesInput,
} from "@nightwatch/shared";
import { getDocker, parseDockerMux } from "../docker-client.js";

export async function getContainerList(
  _input: GetContainerListInput,
): Promise<{ containers: ContainerInfo[] }> {
  const docker = getDocker();
  const raw = await docker.listContainers({ all: true });
  const containers = raw.map((c) => {
    const status = c.Status;
    const image = c.Image;
    return {
      name: (c.Names[0] ?? "").replace(/^\//, ""),
      id: c.Id.slice(0, 12),
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
  input: GetContainerLogsInput,
): Promise<ContainerLogsResult> {
  const docker = getDocker();
  const container = docker.getContainer(input.containerName);

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
  input: GetContainerInspectInput,
): Promise<ContainerInspectResult> {
  const docker = getDocker();
  const raw = await docker.getContainer(input.containerName).inspect();

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
  input: GetContainerStatsInput,
): Promise<ContainerStatsResult> {
  const docker = getDocker();
  const raw = await docker
    .getContainer(input.containerName)
    .stats({ stream: false });

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

  // memory_stats.usage includes reclaimable page cache on cgroup v1. Docker's
  // own CLI subtracts total_inactive_file (cgroup v1) or inactive_file (cgroup
  // v2) to match what is actually in use by the workload.
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
  input: GetContainerEventsInput,
): Promise<{ events: ContainerEvent[] }> {
  const docker = getDocker();
  const now = Math.floor(Date.now() / 1000);
  const since = now - (input.sinceMinutes ?? 60) * 60;

  const stream = await docker.getEvents({
    since,
    until: now,
    filters: JSON.stringify({ name: [input.containerName] }),
  });

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const text = Buffer.concat(chunks).toString("utf8");
  const events: ContainerEvent[] = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const data = JSON.parse(line) as Record<string, unknown>;
      const action = String(data["Action"] ?? "");
      const actor = data["Actor"] as Record<string, unknown> | undefined;
      return {
        timestamp: new Date(Number(data["time"]) * 1000).toISOString(),
        eventType: normalizeEventType(action),
        message: action,
        actor: String(actor?.["ID"] ?? "").slice(0, 12),
      };
    });

  return { events };
}

export async function getContainerProcesses(
  input: GetContainerProcessesInput,
): Promise<{ processes: ContainerProcess[] }> {
  const docker = getDocker();
  const top = (await docker.getContainer(input.containerName).top()) as {
    Titles: string[];
    Processes: string[][];
  };

  const titles = top.Titles ?? [];
  const uidIdx = titles.indexOf("UID");
  const pidIdx = titles.indexOf("PID");
  const ppidIdx = titles.indexOf("PPID");
  const cIdx = titles.indexOf("C");
  const cmdIdx = titles.indexOf("CMD");

  const processes: ContainerProcess[] = (top.Processes ?? []).map((row) => ({
    pid: parseInt(row[pidIdx] ?? "0", 10),
    ppid: parseInt(row[ppidIdx] ?? "0", 10),
    user: row[uidIdx] ?? "unknown",
    cpuPercent: parseFloat(row[cIdx] ?? "0"),
    memPercent: 0,
    command: row[cmdIdx] ?? "",
  }));

  return { processes };
}

export async function getEnvVariableNames(
  input: GetEnvVariableNamesInput,
): Promise<{ names: string[] }> {
  const docker = getDocker();
  const info = await docker.getContainer(input.containerName).inspect();
  const names = (info.Config.Env ?? []).map((e) => e.split("=")[0] ?? e);
  return { names };
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

function normalizeEventType(action: string): ContainerEvent["eventType"] {
  const map: Record<string, ContainerEvent["eventType"]> = {
    start: "start",
    stop: "stop",
    restart: "restart",
    oom: "oom",
    die: "die",
    health_status: "health_status",
    pull: "pull",
    create: "create",
    destroy: "destroy",
  };
  return map[action] ?? "die";
}
