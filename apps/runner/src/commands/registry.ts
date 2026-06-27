import {
  getContainerList as dockerGetContainerList,
  getContainerLogs as dockerGetContainerLogs,
  getContainerInspect as dockerGetContainerInspect,
  getContainerStats as dockerGetContainerStats,
  getContainerEvents as dockerGetContainerEvents,
  getContainerProcesses as dockerGetContainerProcesses,
  getEnvVariableNames as dockerGetEnvVariableNames,
} from "./container.js";
import {
  getContainerList as k8sGetContainerList,
  getContainerLogs as k8sGetContainerLogs,
  getContainerInspect as k8sGetContainerInspect,
  getContainerStats as k8sGetContainerStats,
  getContainerEvents as k8sGetContainerEvents,
  getContainerProcesses as k8sGetContainerProcesses,
  getEnvVariableNames as k8sGetEnvVariableNames,
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
import {
  restartContainer,
  execCommand,
  updateAlertRules,
} from "./remediation.js";

type Handler = (input: unknown) => Promise<unknown>;

function serviceProvider(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const svc = (input as Record<string, unknown>)["service"]; // typeof guard above confirms object shape
  if (typeof svc !== "object" || svc === null) return undefined;
  const provider = (svc as Record<string, unknown>)["provider"]; // same reason
  return typeof provider === "string" ? provider : undefined;
}

// A provider-agnostic command dispatches to the docker or kubernetes handler by
// the service identity's provider. One helper replaces the per-command ternary
// and localizes the unknown->typed cast at the single dispatch boundary.
function byProvider<T>(handlers: {
  docker: (input: T) => Promise<unknown>;
  kubernetes: (input: T) => Promise<unknown>;
}): Handler {
  return (input) =>
    (serviceProvider(input) === "kubernetes"
      ? handlers.kubernetes
      : handlers.docker)(input as T);
}

// list_services carries no service identity (it is the discovery call), so it
// dispatches on its `environment` input instead of a service provider.
function byEnvironment<T extends { environment?: string }>(handlers: {
  docker: (input: T) => Promise<unknown>;
  kubernetes: (input: T) => Promise<unknown>;
}): Handler {
  return (input) => {
    const i = input as T;
    return (
      i.environment === "kubernetes" ? handlers.kubernetes : handlers.docker
    )(i);
  };
}

// A single-provider or provider-less command: cast once and call.
function direct<T>(fn: (input: T) => Promise<unknown>): Handler {
  return (input) => fn(input as T);
}

export function createDispatchRegistry(): Map<string, Handler> {
  return new Map<string, Handler>([
    [
      "list_services",
      byEnvironment({
        docker: dockerGetContainerList,
        kubernetes: k8sGetContainerList,
      }),
    ],
    [
      "get_service_logs",
      byProvider({
        docker: dockerGetContainerLogs,
        kubernetes: k8sGetContainerLogs,
      }),
    ],
    [
      "get_service_config",
      byProvider({
        docker: dockerGetContainerInspect,
        kubernetes: k8sGetContainerInspect,
      }),
    ],
    [
      "get_service_stats",
      byProvider({
        docker: dockerGetContainerStats,
        kubernetes: k8sGetContainerStats,
      }),
    ],
    [
      "get_service_events",
      byProvider({
        docker: dockerGetContainerEvents,
        kubernetes: k8sGetContainerEvents,
      }),
    ],
    [
      "get_service_processes",
      byProvider({
        docker: dockerGetContainerProcesses,
        kubernetes: k8sGetContainerProcesses,
      }),
    ],
    [
      "get_service_env_names",
      byProvider({
        docker: dockerGetEnvVariableNames,
        kubernetes: k8sGetEnvVariableNames,
      }),
    ],
    ["get_host_memory", () => getHostMemory()],
    ["get_host_cpu", () => getHostCpu()],
    ["get_host_disk", () => getHostDisk()],
    ["get_host_network", () => getHostNetwork()],
    ["get_host_dmesg", direct(getHostDmesg)],
    ["read_file", direct(readFileCommand)],
    [
      "restart_service",
      byProvider({ docker: restartContainer, kubernetes: k8sRestartService }),
    ],
    [
      "exec_command",
      byProvider({ docker: execCommand, kubernetes: k8sExecCommand }),
    ],
    ["get_k8s_rollout_status", direct(k8sGetRolloutStatus)],
    ["get_k8s_node_status", () => k8sGetNodeStatus()],
    ["update_alert_rules", direct(updateAlertRules)],
  ]);
}
