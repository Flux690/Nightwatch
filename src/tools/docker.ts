import Docker from "dockerode";
import { Type } from "@google/genai";

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

export const listContainersDeclaration = {
  name: "list_containers",
  description:
    "Lists all Docker containers with their name, image, state, and status. Use this when logs alone are insufficient to determine service availability.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: [],
  },
};

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

export const inspectContainerDeclaration = {
  name: "inspect_container",
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
      envKeys: (config.Env ?? []).map((env) => env.split("=")[0]),
      restartPolicy: hostConfig.RestartPolicy?.Name ?? "none",
    },
    filesystem: {
      mounts: (data.Mounts ?? []).map((m) => ({
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
