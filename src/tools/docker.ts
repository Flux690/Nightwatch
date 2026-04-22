import Docker from "dockerode";
import { PassThrough } from "stream";
import { Type } from "@google/genai";
import type { AgentTool } from "../llm/runtime";
import type { ToolCache } from "./cache";

/** Shared Docker client instance */
export const docker = new Docker();

export type ContainerSummary = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
};

export type ContainerInspection = {
  name: string;
  state: {
    status: string;
    running: boolean;
    oomKilled: boolean;
    restartCount: number;
    exitCode: number;
    startedAt?: string;
    health?: string;
  };
  resources: {
    memoryLimitBytes: number | null;
    memorySwapBytes: number | null;
    cpuQuota: number | null;
    cpuPeriod: number | null;
    cpuShares: number | null;
  };
  config: {
    image: string;
    envKeys: string[];
    restartPolicy: string;
  };
  filesystem: {
    mounts: {
      source: string;
      destination: string;
      mode: string;
      rw: boolean;
    }[];
  };
  network: {
    mode: string;
    ports: Record<string, unknown>;
  };
};

export type ContainerStats = {
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  pids: number;
};

export type ContainerLogs = {
  lines: string[];
  lineCount: number;
};

export type ContainerTop = {
  titles: string[];
  processes: string[][];
};

// --- Declarations ---

export const listContainersDeclaration = {
  name: "docker.list",
  description:
    "Lists all Docker containers with their name, image, state, and status. Use this when logs alone are insufficient to determine service availability.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: [],
  },
};

export const inspectContainerDeclaration = {
  name: "docker.inspect",
  description:
    "Retrieve detailed runtime configuration and state of a Docker container, including resource limits, mounts, network, and health.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: "Name of the Docker container to inspect",
      },
    },
    required: ["name"],
  },
};

export const statsContainerDeclaration = {
  name: "docker.stats",
  description:
    "Get live resource usage statistics for a Docker container: CPU%, memory usage/limit, network I/O, and PID count.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: "Name of the Docker container to get stats for",
      },
    },
    required: ["name"],
  },
};

export const logsContainerDeclaration = {
  name: "docker.logs",
  description:
    "Retrieve recent log lines from a Docker container. Returns the last N lines of combined stdout and stderr.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: "Name of the Docker container",
      },
      tail: {
        type: Type.NUMBER,
        description: "Number of lines to retrieve from the end (default: 10)",
      },
    },
    required: ["name"],
  },
};

export const topContainerDeclaration = {
  name: "docker.top",
  description:
    "List processes running inside a Docker container, including PID, user, CPU, memory, and command.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: "Name of the Docker container",
      },
    },
    required: ["name"],
  },
};

// --- Handlers ---

export async function listContainersTool(): Promise<ContainerSummary[]> {
  const containers = await docker.listContainers({ all: true });

  return containers.map((container) => ({
    id: container.Id,
    name: container.Names?.[0]?.replace(/^\//, "") ?? "",
    image: container.Image,
    state: container.State,
    status: container.Status,
  }));
}

export async function inspectContainerTool(
  containerName: string,
): Promise<ContainerInspection> {
  const container = docker.getContainer(containerName);
  const data = await container.inspect();

  const state = data.State ?? {};
  const hostConfig = data.HostConfig ?? {};
  const config = data.Config ?? {};

  return {
    name: data.Name?.replace(/^\//, "") ?? containerName,
    state: {
      status: state.Status ?? "unknown",
      running: Boolean(state.Running),
      oomKilled: Boolean(state.OOMKilled),
      restartCount: data.RestartCount ?? 0,
      exitCode: state.ExitCode ?? 0,
      startedAt: state.StartedAt,
      health: state.Health?.Status,
    },
    resources: {
      memoryLimitBytes:
        typeof hostConfig.Memory === "number" && hostConfig.Memory > 0
          ? hostConfig.Memory
          : null,
      memorySwapBytes:
        typeof hostConfig.MemorySwap === "number" && hostConfig.MemorySwap > 0
          ? hostConfig.MemorySwap
          : null,
      cpuQuota:
        typeof hostConfig.CpuQuota === "number" && hostConfig.CpuQuota > 0
          ? hostConfig.CpuQuota
          : null,
      cpuPeriod:
        typeof hostConfig.CpuPeriod === "number" && hostConfig.CpuPeriod > 0
          ? hostConfig.CpuPeriod
          : null,
      cpuShares:
        typeof hostConfig.CpuShares === "number" && hostConfig.CpuShares > 0
          ? hostConfig.CpuShares
          : null,
    },
    config: {
      image: config.Image ?? "",
      envKeys: (config.Env ?? []).map((env: string) => env.split("=")[0]),
      restartPolicy: hostConfig.RestartPolicy?.Name ?? "none",
    },
    filesystem: {
      mounts: (data.Mounts ?? []).map((m: any) => ({
        source: m.Source ?? "",
        destination: m.Destination ?? "",
        mode: m.Mode ?? "",
        rw: Boolean(m.RW),
      })),
    },
    network: {
      mode: hostConfig.NetworkMode ?? "unknown",
      ports: data.NetworkSettings?.Ports ?? {},
    },
  };
}

export async function statsContainerTool(
  containerName: string,
): Promise<ContainerStats> {
  const container = docker.getContainer(containerName);
  const stats = (await container.stats({ stream: false })) as any;

  // CPU calculation
  const cpuDelta =
    stats.cpu_stats.cpu_usage.total_usage -
    stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const numCpus = stats.cpu_stats.online_cpus ?? 1;
  const cpuPercent =
    systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

  // Memory
  const memoryUsageBytes = stats.memory_stats.usage ?? 0;
  const memoryLimitBytes = stats.memory_stats.limit ?? 0;
  const memoryPercent =
    memoryLimitBytes > 0 ? (memoryUsageBytes / memoryLimitBytes) * 100 : 0;

  // Network
  let networkRxBytes = 0;
  let networkTxBytes = 0;
  if (stats.networks) {
    for (const iface of Object.values(stats.networks) as any[]) {
      networkRxBytes += iface.rx_bytes ?? 0;
      networkTxBytes += iface.tx_bytes ?? 0;
    }
  }

  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memoryUsageBytes,
    memoryLimitBytes,
    memoryPercent: Math.round(memoryPercent * 100) / 100,
    networkRxBytes,
    networkTxBytes,
    pids: stats.pids_stats?.current ?? 0,
  };
}

export async function logsContainerTool(
  containerName: string,
  tail: number = 10,
): Promise<ContainerLogs> {
  const container = docker.getContainer(containerName);
  const logStream = await container.logs({
    tail,
    stdout: true,
    stderr: true,
    follow: false,
  });

  // Use Dockerode's demuxer to properly handle both multiplexed and TTY streams.
  // This matches the approach in observeContainerLogs.ts and correctly handles
  // containers regardless of TTY configuration.
  const lines: string[] = [];

  return new Promise<ContainerLogs>((resolve, reject) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const collectLines = (stream: PassThrough) => {
      stream.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        for (const line of text.split("\n")) {
          const trimmed = line.trimEnd();
          if (trimmed) lines.push(trimmed);
        }
      });
    };

    collectLines(stdout);
    collectLines(stderr);

    // Wrap buffer in a PassThrough so demuxStream can process it
    const input = new PassThrough();
    container.modem.demuxStream(input, stdout, stderr);

    input.on("error", reject);
    stdout.on("error", reject);
    stderr.on("error", reject);

    input.on("end", () => {
      stdout.end();
      stderr.end();
      resolve({ lines, lineCount: lines.length });
    });

    // Write the response buffer and signal end
    const raw = Buffer.isBuffer(logStream)
      ? logStream
      : Buffer.from(logStream as any);
    input.end(raw);
  });
}

export async function topContainerTool(
  containerName: string,
): Promise<ContainerTop> {
  const container = docker.getContainer(containerName);
  const result = await container.top();

  return {
    titles: result.Titles ?? [],
    processes: result.Processes ?? [],
  };
}

// --- Cache-aware tool factory ---

/**
 * Creates all 5 diagnostic tools with cache-aware handlers.
 * Each handler checks the cache before calling the Docker API.
 */
export function createDiagnosticTools(cache?: ToolCache): AgentTool[] {
  function cached<T>(
    toolName: string,
    args: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!cache) return fn();
    const hit = cache.get<T>(toolName, args);
    if (hit !== undefined) return Promise.resolve(hit);
    return fn().then((result) => {
      cache.set(toolName, args, result);
      return result;
    });
  }

  return [
    {
      declaration: listContainersDeclaration,
      handler: async () =>
        cached("docker.list", {}, () => listContainersTool()),
    },
    {
      declaration: inspectContainerDeclaration,
      handler: async (args) => {
        const { name } = args as { name: string };
        return cached("docker.inspect", { name }, () =>
          inspectContainerTool(name),
        );
      },
    },
    {
      declaration: statsContainerDeclaration,
      handler: async (args) => {
        const { name } = args as { name: string };
        return cached("docker.stats", { name }, () => statsContainerTool(name));
      },
    },
    {
      declaration: logsContainerDeclaration,
      handler: async (args) => {
        const { name, tail } = args as { name: string; tail?: number };
        return cached("docker.logs", { name, tail: tail ?? 10 }, () =>
          logsContainerTool(name, tail),
        );
      },
    },
    {
      declaration: topContainerDeclaration,
      handler: async (args) => {
        const { name } = args as { name: string };
        return cached("docker.top", { name }, () => topContainerTool(name));
      },
    },
  ];
}
