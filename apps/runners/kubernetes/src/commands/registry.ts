import { decode, type CommandHandler } from "@nightwarden/runner-core";
import {
  k8sConfigInputSchema,
  k8sEventsInputSchema,
  k8sExecInputSchema,
  k8sLogsInputSchema,
  k8sProcessesInputSchema,
  k8sRestartInputSchema,
  k8sRolloutStatusInputSchema,
  k8sStatsInputSchema,
  k8sWorkloadListInputSchema,
} from "@nightwarden/shared/schemas";
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

// Every command this binary can serve. A Docker command has no entry here and no
// handler in the bundle, so it fails at lookup rather than at a runtime guard.
export function createDispatchRegistry(): Map<string, CommandHandler> {
  return new Map<string, CommandHandler>([
    [
      "ListK8sWorkloads",
      async (input) => listWorkloads(decode(k8sWorkloadListInputSchema, input)),
    ],
    [
      "GetK8sLogs",
      async (input) => getWorkloadLogs(decode(k8sLogsInputSchema, input)),
    ],
    [
      "GetK8sConfig",
      async (input) => describeWorkload(decode(k8sConfigInputSchema, input)),
    ],
    [
      "GetK8sStats",
      async (input) => getWorkloadStats(decode(k8sStatsInputSchema, input)),
    ],
    [
      "GetK8sEvents",
      async (input) => getWorkloadEvents(decode(k8sEventsInputSchema, input)),
    ],
    [
      "GetK8sProcesses",
      async (input) =>
        getWorkloadProcesses(decode(k8sProcessesInputSchema, input)),
    ],
    [
      "RestartK8sWorkload",
      async (input) => restartWorkload(decode(k8sRestartInputSchema, input)),
    ],
    [
      "K8sExec",
      async (input) => execInWorkload(decode(k8sExecInputSchema, input)),
    ],
    [
      "GetK8sRolloutStatus",
      async (input) =>
        getRolloutStatus(decode(k8sRolloutStatusInputSchema, input)),
    ],
    ["GetK8sNodeStatus", async () => getNodeStatus()],
  ]);
}
