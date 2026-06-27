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
import type {
  GetContainerListInput,
  GetContainerLogsInput,
  GetContainerInspectInput,
  GetContainerStatsInput,
  GetContainerEventsInput,
  GetContainerProcessesInput,
  GetEnvVariableNamesInput,
  ExecCommandInput,
  GetK8sRolloutStatusInput,
  RestartContainerInput,
} from "@nightwatch/shared";

type Handler = (input: unknown) => Promise<unknown>;

function serviceProvider(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const svc = (input as Record<string, unknown>)["service"]; // typeof guard above confirms object shape
  if (typeof svc !== "object" || svc === null) return undefined;
  const provider = (svc as Record<string, unknown>)["provider"]; // same reason
  return typeof provider === "string" ? provider : undefined;
}

export function createDispatchRegistry(): Map<string, Handler> {
  return new Map<string, Handler>([
    [
      "list_services",
      (i) => {
        const input = i as GetContainerListInput;
        return input.environment === "kubernetes"
          ? k8sGetContainerList(input)
          : dockerGetContainerList(input);
      },
    ],
    [
      "get_service_logs",
      (i) =>
        serviceProvider(i) === "kubernetes"
          ? k8sGetContainerLogs(i as GetContainerLogsInput)
          : dockerGetContainerLogs(i as GetContainerLogsInput),
    ],
    [
      "get_service_config",
      (i) =>
        serviceProvider(i) === "kubernetes"
          ? k8sGetContainerInspect(i as GetContainerInspectInput)
          : dockerGetContainerInspect(i as GetContainerInspectInput),
    ],
    [
      "get_service_stats",
      (i) =>
        serviceProvider(i) === "kubernetes"
          ? k8sGetContainerStats(i as GetContainerStatsInput)
          : dockerGetContainerStats(i as GetContainerStatsInput),
    ],
    [
      "get_service_events",
      (i) =>
        serviceProvider(i) === "kubernetes"
          ? k8sGetContainerEvents(i as GetContainerEventsInput)
          : dockerGetContainerEvents(i as GetContainerEventsInput),
    ],
    [
      "get_service_processes",
      (i) =>
        serviceProvider(i) === "kubernetes"
          ? k8sGetContainerProcesses(i as GetContainerProcessesInput)
          : dockerGetContainerProcesses(i as GetContainerProcessesInput),
    ],
    [
      "get_service_env_names",
      (i) =>
        serviceProvider(i) === "kubernetes"
          ? k8sGetEnvVariableNames(i as GetEnvVariableNamesInput)
          : dockerGetEnvVariableNames(i as GetEnvVariableNamesInput),
    ],
    ["get_host_memory", () => getHostMemory()],
    ["get_host_cpu", () => getHostCpu()],
    ["get_host_disk", () => getHostDisk()],
    ["get_host_network", () => getHostNetwork()],
    [
      "get_host_dmesg",
      (i) => getHostDmesg(i as Parameters<typeof getHostDmesg>[0]),
    ],
    [
      "read_file",
      (i) => readFileCommand(i as Parameters<typeof readFileCommand>[0]),
    ],
    [
      "restart_service",
      (i) =>
        serviceProvider(i) === "kubernetes"
          ? k8sRestartService(i as RestartContainerInput)
          : restartContainer(i as RestartContainerInput),
    ],
    [
      "exec_command",
      (i) =>
        serviceProvider(i) === "kubernetes"
          ? k8sExecCommand(i as ExecCommandInput)
          : execCommand(i as ExecCommandInput),
    ],
    [
      "get_k8s_rollout_status",
      (i) => k8sGetRolloutStatus(i as GetK8sRolloutStatusInput),
    ],
    ["get_k8s_node_status", () => k8sGetNodeStatus()],
    ["update_alert_rules", (i) => updateAlertRules(i as { rulesYaml: string })],
  ]);
}
