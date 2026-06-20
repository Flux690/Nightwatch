import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const exec = promisify(execFile);

export async function getContainerList(
  _input: GetContainerListInput,
): Promise<{ containers: ContainerInfo[] }> {
  const { stdout } = await exec("docker", [
    "ps",
    "-a",
    "--format",
    "{{json .}}",
  ]);
  const containers = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const raw = JSON.parse(line) as Record<string, string>;
      const status = raw["Status"] ?? "";
      const image = raw["Image"] ?? "";
      return {
        name: (raw["Names"] ?? "").replace(/^\//, ""),
        id: (raw["ID"] ?? "").slice(0, 12),
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
  const args = ["logs", "--tail", String(input.tailLines ?? 200)];
  if (input.sinceTimestamp) args.push("--since", input.sinceTimestamp);
  if (input.stderrOnly) args.push("--stderr");
  args.push(input.containerName);

  const { stdout, stderr } = await exec("docker", args, {
    maxBuffer: 10 * 1024 * 1024,
  });
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
  const { stdout } = await exec("docker", ["inspect", input.containerName]);
  const arr = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const raw = arr[0];
  if (!raw) throw new Error(`Container not found: ${input.containerName}`);

  const config = raw["Config"] as Record<string, unknown>;
  const state = raw["State"] as Record<string, unknown>;
  const hostConfig = raw["HostConfig"] as Record<string, unknown>;
  const networkSettings = raw["NetworkSettings"] as Record<string, unknown>;
  const health = state["Health"] as Record<string, unknown> | undefined;
  const healthcheck = config["Healthcheck"] as
    | Record<string, unknown>
    | undefined;

  const envVarNames = ((config["Env"] as string[] | undefined) ?? []).map(
    (e) => e.split("=")[0] ?? e,
  );

  return {
    name: (raw["Name"] as string).replace(/^\//, ""),
    image: config["Image"] as string,
    imageDigest: raw["Image"] as string,
    envVarNames,
    mounts: (raw["Mounts"] as unknown[]) ?? [],
    ports: Object.keys(
      (networkSettings["Ports"] as Record<string, unknown>) ?? {},
    ),
    restartPolicy:
      ((hostConfig["RestartPolicy"] as Record<string, unknown>)?.[
        "Name"
      ] as string) ?? "no",
    healthCheck: {
      test: (healthcheck?.["Test"] as string[]) ?? [],
      interval: ((healthcheck?.["Interval"] as number) ?? 0) / 1e9,
      retries: (healthcheck?.["Retries"] as number) ?? 0,
      lastResult: (health?.["Status"] as string) ?? "none",
    },
    createdAt: raw["Created"] as string,
    startedAt: state["StartedAt"] as string,
  };
}

export async function getContainerStats(
  input: GetContainerStatsInput,
): Promise<ContainerStatsResult> {
  const { stdout } = await exec("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{json .}}",
    input.containerName,
  ]);
  const raw = JSON.parse(stdout.trim()) as Record<string, string>;

  const memParts = (raw["MemUsage"] ?? "0B / 0B").split(" / ");
  const netParts = (raw["NetIO"] ?? "0B / 0B").split(" / ");
  const blockParts = (raw["BlockIO"] ?? "0B / 0B").split(" / ");

  return {
    cpuPercent: parseFloat(raw["CPUPerc"] ?? "0"),
    memoryUsedBytes: parseHumanBytes(memParts[0] ?? "0B"),
    memoryLimitBytes: parseHumanBytes(memParts[1] ?? "0B"),
    memoryPercent: parseFloat(raw["MemPerc"] ?? "0"),
    networkRxBytes: parseHumanBytes(netParts[0] ?? "0B"),
    networkTxBytes: parseHumanBytes(netParts[1] ?? "0B"),
    blockReadBytes: parseHumanBytes(blockParts[0] ?? "0B"),
    blockWriteBytes: parseHumanBytes(blockParts[1] ?? "0B"),
    pids: parseInt(raw["PIDs"] ?? "0", 10),
  };
}

export async function getContainerEvents(
  input: GetContainerEventsInput,
): Promise<{ events: ContainerEvent[] }> {
  const since = `${input.sinceMinutes ?? 60}m`;
  const { stdout } = await exec("docker", [
    "events",
    "--since",
    since,
    "--until",
    "0s",
    "--format",
    "{{json .}}",
    "--filter",
    `name=${input.containerName}`,
  ]);

  const events: ContainerEvent[] = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const action = String(raw["Action"] ?? "");
      const actor = raw["Actor"] as Record<string, unknown> | undefined;
      return {
        timestamp: new Date(Number(raw["time"]) * 1000).toISOString(),
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
  const { stdout } = await exec("docker", ["top", input.containerName]);
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) return { processes: [] };

  // docker top: UID PID PPID C STIME TTY TIME CMD
  const processes: ContainerProcess[] = lines.slice(1).map((line) => {
    const cols = line.trim().split(/\s+/);
    return {
      pid: parseInt(cols[1] ?? "0", 10),
      ppid: parseInt(cols[2] ?? "0", 10),
      user: cols[0] ?? "unknown",
      cpuPercent: parseFloat(cols[3] ?? "0"),
      memPercent: 0,
      command: cols.slice(7).join(" ") || cols.slice(4).join(" "),
    };
  });

  return { processes };
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

function parseHumanBytes(s: string): number {
  const t = s.trim();
  const n = parseFloat(t);
  if (isNaN(n)) return 0;
  if (t.endsWith("GiB") || t.endsWith("GB")) return Math.round(n * 1024 ** 3);
  if (t.endsWith("MiB") || t.endsWith("MB")) return Math.round(n * 1024 ** 2);
  if (t.endsWith("KiB") || t.endsWith("kB") || t.endsWith("KB"))
    return Math.round(n * 1024);
  return Math.round(n);
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

export async function getEnvVariableNames(
  input: GetEnvVariableNamesInput,
): Promise<{ names: string[] }> {
  const { stdout } = await exec("docker", ["inspect", input.containerName]);
  const arr = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const raw = arr[0];
  if (!raw) throw new Error(`Container not found: ${input.containerName}`);

  const config = raw["Config"] as Record<string, unknown> | undefined;
  const env = (config?.["Env"] as string[] | undefined) ?? [];
  const names = env.map((e) => e.split("=")[0] ?? e);

  return { names };
}
