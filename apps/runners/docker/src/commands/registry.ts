import { decode, type CommandHandler } from "@nightwarden/runner-core";
import {
  dockerConfigInputSchema,
  dockerEventsInputSchema,
  dockerExecInputSchema,
  dockerLogsInputSchema,
  dockerProcessesInputSchema,
  dockerRestartInputSchema,
  dockerStatsInputSchema,
  hostDmesgInputSchema,
  hostFileInputSchema,
} from "@nightwarden/shared/schemas";
import {
  getContainerList,
  getContainerLogs,
  getContainerInspect,
  getContainerStats,
  getContainerEvents,
  getContainerProcesses,
  restartContainer,
  execCommand,
} from "../docker/commands.js";
import {
  getHostMemory,
  getHostCpu,
  getHostDisk,
  getHostNetwork,
  getHostDmesg,
} from "./host.js";
import { readFileCommand } from "./files.js";

// Every command this binary can serve. A Kubernetes command has no entry here and no
// handler in the bundle, so it fails at lookup rather than at a runtime guard.
export function createDispatchRegistry(): Map<string, CommandHandler> {
  return new Map<string, CommandHandler>([
    ["ListDockerServices", async () => getContainerList()],
    [
      "GetDockerLogs",
      async (input) => getContainerLogs(decode(dockerLogsInputSchema, input)),
    ],
    [
      "GetDockerConfig",
      async (input) =>
        getContainerInspect(decode(dockerConfigInputSchema, input)),
    ],
    [
      "GetDockerStats",
      async (input) => getContainerStats(decode(dockerStatsInputSchema, input)),
    ],
    [
      "GetDockerEvents",
      async (input) =>
        getContainerEvents(decode(dockerEventsInputSchema, input)),
    ],
    [
      "GetDockerProcesses",
      async (input) =>
        getContainerProcesses(decode(dockerProcessesInputSchema, input)),
    ],
    [
      "RestartDockerService",
      async (input) =>
        restartContainer(decode(dockerRestartInputSchema, input)),
    ],
    [
      "DockerExec",
      async (input) => execCommand(decode(dockerExecInputSchema, input)),
    ],
    ["GetHostMemory", async () => getHostMemory()],
    ["GetHostCPU", async () => getHostCpu()],
    ["GetHostDisk", async () => getHostDisk()],
    ["GetHostNetwork", async () => getHostNetwork()],
    [
      "GetHostDmesg",
      async (input) => getHostDmesg(decode(hostDmesgInputSchema, input)),
    ],
    [
      "ReadHostFile",
      async (input) => readFileCommand(decode(hostFileInputSchema, input)),
    ],
  ]);
}
