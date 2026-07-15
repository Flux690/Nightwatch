import {
  getContainerList as dockerGetContainerList,
  getContainerLogs as dockerGetContainerLogs,
  getContainerInspect as dockerGetContainerInspect,
  getContainerStats as dockerGetContainerStats,
  getContainerEvents as dockerGetContainerEvents,
  getContainerProcesses as dockerGetContainerProcesses,
  restartContainer,
  execCommand,
} from "../docker/commands.js";
import {
  getContainerList as k8sGetContainerList,
  getContainerLogs as k8sGetContainerLogs,
  getContainerInspect as k8sGetContainerInspect,
  getContainerStats as k8sGetContainerStats,
  getContainerEvents as k8sGetContainerEvents,
  getContainerProcesses as k8sGetContainerProcesses,
  restartService as k8sRestartService,
  execCommand as k8sExecCommand,
  getRolloutStatus as k8sGetRolloutStatus,
  getNodeStatus as k8sGetNodeStatus,
} from "../kubernetes/commands.js";
import {
  getHostMemory,
  getHostCpu,
  getHostDisk,
  getHostNetwork,
  getHostDmesg,
} from "./host.js";
import { readFileCommand } from "./files.js";
import { isRemediationEnabled } from "../remediation-state.js";

type Handler = (input: unknown) => Promise<unknown>;

// Each command name maps 1:1 to a provider handler - the LLM tool name already
// carries the substrate, so there is no runtime provider dispatch to do.
function direct<T>(fn: (input: T) => Promise<unknown>): Handler {
  return (input) => fn(input as T);
}

// Defense in depth for writes: the API gates by this runner's mode, but the runner still refuses on its
// own flag so a control-plane bug can never execute a write the operator turned off here.
function guardedWrite(handler: Handler): Handler {
  return (input) => {
    if (!isRemediationEnabled()) {
      return Promise.reject(
        new Error("Remediation is disabled on this runner"),
      );
    }
    return handler(input);
  };
}

export function createDispatchRegistry(): Map<string, Handler> {
  return new Map<string, Handler>([
    ["ListDockerServices", direct(dockerGetContainerList)],
    ["GetDockerLogs", direct(dockerGetContainerLogs)],
    ["GetDockerConfig", direct(dockerGetContainerInspect)],
    ["GetDockerStats", direct(dockerGetContainerStats)],
    ["GetDockerEvents", direct(dockerGetContainerEvents)],
    ["GetDockerProcesses", direct(dockerGetContainerProcesses)],
    ["RestartDockerService", guardedWrite(direct(restartContainer))],
    ["DockerBash", guardedWrite(direct(execCommand))],
    ["ListK8sWorkloads", direct(k8sGetContainerList)],
    ["GetK8sLogs", direct(k8sGetContainerLogs)],
    ["GetK8sConfig", direct(k8sGetContainerInspect)],
    ["GetK8sStats", direct(k8sGetContainerStats)],
    ["GetK8sEvents", direct(k8sGetContainerEvents)],
    ["GetK8sProcesses", direct(k8sGetContainerProcesses)],
    ["RestartK8sWorkload", guardedWrite(direct(k8sRestartService))],
    ["K8sBash", guardedWrite(direct(k8sExecCommand))],
    ["GetK8sRolloutStatus", direct(k8sGetRolloutStatus)],
    ["GetK8sNodeStatus", () => k8sGetNodeStatus()],
    ["GetHostMemory", () => getHostMemory()],
    ["GetHostCPU", () => getHostCpu()],
    ["GetHostDisk", () => getHostDisk()],
    ["GetHostNetwork", () => getHostNetwork()],
    ["GetHostDmesg", direct(getHostDmesg)],
    ["ReadHostFile", direct(readFileCommand)],
  ]);
}
