import {
  nested,
  optionalNumber,
  optionalString,
  requiredString,
  requiredStringArray,
  type CommandHandler,
} from "@nightwarden/runner-transport";
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
          risk: risk(input),
          estimatedDowntimeSeconds:
            optionalNumber(input, "estimatedDowntimeSeconds") ?? 0,
        }),
    ],
    [
      "K8sBash",
      async (input) =>
        execInWorkload({
          service: service(input),
          command: requiredStringArray(input, "command"),
          reason: requiredString(input, "reason"),
          risk: risk(input),
        }),
    ],
    [
      "GetK8sRolloutStatus",
      async (input) => getRolloutStatus({ service: service(input) }),
    ],
    ["GetK8sNodeStatus", async () => getNodeStatus()],
  ]);
}

const RISKS = ["low", "medium", "high"] as const;

function risk(input: unknown): (typeof RISKS)[number] {
  const value = requiredString(input, "risk");
  const match = RISKS.find((r) => r === value);
  if (!match) throw new Error(`"risk" must be one of: ${RISKS.join(", ")}`);
  return match;
}
