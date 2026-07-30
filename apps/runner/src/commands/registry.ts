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
  listWorkloads,
  getWorkloadLogs,
  describeWorkload,
  getWorkloadStats,
  getWorkloadEvents,
  getWorkloadProcesses,
  restartWorkload,
  execInWorkload,
  getRolloutStatus,
  getNodeStatus,
} from "../kubernetes/commands.js";
import {
  getHostMemory,
  getHostCpu,
  getHostDisk,
  getHostNetwork,
  getHostDmesg,
} from "./host.js";
import { readFileCommand } from "./files.js";

type Handler = (input: unknown) => Promise<unknown>;

// Each command name maps 1:1 to a provider handler - the LLM tool name already
// carries the substrate, so there is no runtime provider dispatch to do.
function direct<T>(fn: (input: T) => Promise<unknown>): Handler {
  return (input) => fn(input as T);
}

export function createDispatchRegistry(): Map<string, Handler> {
  return new Map<string, Handler>([
    ["ListDockerServices", () => getContainerList()],
    ["GetDockerLogs", direct(getContainerLogs)],
    ["GetDockerConfig", direct(getContainerInspect)],
    ["GetDockerStats", direct(getContainerStats)],
    ["GetDockerEvents", direct(getContainerEvents)],
    ["GetDockerProcesses", direct(getContainerProcesses)],
    ["RestartDockerService", direct(restartContainer)],
    ["DockerBash", direct(execCommand)],
    ["ListK8sWorkloads", direct(listWorkloads)],
    ["GetK8sLogs", direct(getWorkloadLogs)],
    ["GetK8sConfig", direct(describeWorkload)],
    ["GetK8sStats", direct(getWorkloadStats)],
    ["GetK8sEvents", direct(getWorkloadEvents)],
    ["GetK8sProcesses", direct(getWorkloadProcesses)],
    ["RestartK8sWorkload", direct(restartWorkload)],
    ["K8sBash", direct(execInWorkload)],
    ["GetK8sRolloutStatus", direct(getRolloutStatus)],
    ["GetK8sNodeStatus", () => getNodeStatus()],
    ["GetHostMemory", () => getHostMemory()],
    ["GetHostCPU", () => getHostCpu()],
    ["GetHostDisk", () => getHostDisk()],
    ["GetHostNetwork", () => getHostNetwork()],
    ["GetHostDmesg", direct(getHostDmesg)],
    ["ReadHostFile", direct(readFileCommand)],
  ]);
}
