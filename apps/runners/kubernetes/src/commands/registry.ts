import {
  executableName,
  nested,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
  requiredString,
  type CommandHandler,
} from "@nightwarden/runner-core";
import type { KubernetesWorkloadIdentity } from "@nightwarden/shared";
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

// The only identity this binary can hold. There is no other arm to reject, so
// nothing downstream has to check which platform it was handed.
function service(input: unknown): KubernetesWorkloadIdentity {
  const raw = nested(input, "service");
  const container = optionalString(raw, "container");
  return {
    namespace: requiredString(raw, "namespace"),
    workload: requiredString(raw, "workload"),
    ...(container !== undefined && { container }),
  };
}

// Every command this binary can serve. A Docker command has no entry here and no
// handler in the bundle, so it fails at lookup rather than at a runtime guard.
export function createDispatchRegistry(): Map<string, CommandHandler> {
  return new Map<string, CommandHandler>([
    [
      "ListK8sWorkloads",
      async (input) =>
        listWorkloads({ namespace: optionalString(input, "namespace") }),
    ],
    [
      "GetK8sLogs",
      async (input) =>
        getWorkloadLogs({
          service: service(input),
          tailLines: optionalNumber(input, "tailLines"),
          since: optionalString(input, "since"),
          contains: optionalStringArray(input, "contains"),
          excludes: optionalStringArray(input, "excludes"),
        }),
    ],
    [
      "GetK8sConfig",
      async (input) => describeWorkload({ service: service(input) }),
    ],
    [
      "GetK8sStats",
      async (input) => getWorkloadStats({ service: service(input) }),
    ],
    [
      "GetK8sEvents",
      async (input) =>
        getWorkloadEvents({
          service: service(input),
          sinceMinutes: optionalNumber(input, "sinceMinutes"),
          warningsOnly: optionalBoolean(input, "warningsOnly"),
        }),
    ],
    [
      "GetK8sProcesses",
      async (input) => getWorkloadProcesses({ service: service(input) }),
    ],
    [
      "RestartK8sWorkload",
      async (input) =>
        restartWorkload({
          service: service(input),
          reason: requiredString(input, "reason"),
          estimatedDowntimeSeconds:
            optionalNumber(input, "estimatedDowntimeSeconds") ?? 0,
        }),
    ],
    [
      "K8sExec",
      async (input) =>
        execInWorkload({
          service: service(input),
          executable: executableName(input),
          args: optionalStringArray(input, "args") ?? [],
          reason: requiredString(input, "reason"),
        }),
    ],
    [
      "GetK8sRolloutStatus",
      async (input) => getRolloutStatus({ service: service(input) }),
    ],
    ["GetK8sNodeStatus", async () => getNodeStatus()],
  ]);
}
