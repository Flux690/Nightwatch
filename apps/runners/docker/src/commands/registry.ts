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
import type { DockerServiceIdentity } from "@nightwarden/shared";
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

// The only identity this binary can hold. There is no other arm to reject, so
// nothing downstream has to check which platform it was handed.
function service(input: unknown): DockerServiceIdentity {
  const raw = nested(input, "service");
  return {
    project: requiredString(raw, "project"),
    service: requiredString(raw, "service"),
  };
}

// Every command this binary can serve. A Kubernetes command has no entry here and no
// handler in the bundle, so it fails at lookup rather than at a runtime guard.
export function createDispatchRegistry(): Map<string, CommandHandler> {
  return new Map<string, CommandHandler>([
    ["ListDockerServices", async () => getContainerList()],
    [
      "GetDockerLogs",
      async (input) =>
        getContainerLogs({
          service: service(input),
          tailLines: optionalNumber(input, "tailLines"),
          since: optionalString(input, "since"),
          until: optionalString(input, "until"),
          contains: optionalStringArray(input, "contains"),
          excludes: optionalStringArray(input, "excludes"),
          stderrOnly: optionalBoolean(input, "stderrOnly"),
        }),
    ],
    [
      "GetDockerConfig",
      async (input) => getContainerInspect({ service: service(input) }),
    ],
    [
      "GetDockerStats",
      async (input) => getContainerStats({ service: service(input) }),
    ],
    [
      "GetDockerEvents",
      async (input) =>
        getContainerEvents({
          service: service(input),
          sinceMinutes: optionalNumber(input, "sinceMinutes"),
        }),
    ],
    [
      "GetDockerProcesses",
      async (input) => getContainerProcesses({ service: service(input) }),
    ],
    [
      "RestartDockerService",
      async (input) =>
        restartContainer({
          service: service(input),
          delaySeconds: optionalNumber(input, "delaySeconds"),
          reason: requiredString(input, "reason"),
          estimatedDowntimeSeconds:
            optionalNumber(input, "estimatedDowntimeSeconds") ?? 0,
        }),
    ],
    [
      "DockerExec",
      async (input) =>
        execCommand({
          service: service(input),
          executable: executableName(input),
          args: optionalStringArray(input, "args") ?? [],
          reason: requiredString(input, "reason"),
        }),
    ],
    ["GetHostMemory", async () => getHostMemory()],
    ["GetHostCPU", async () => getHostCpu()],
    ["GetHostDisk", async () => getHostDisk()],
    ["GetHostNetwork", async () => getHostNetwork()],
    [
      "GetHostDmesg",
      async (input) =>
        getHostDmesg({
          tailLines: optionalNumber(input, "tailLines"),
          filterLevel: filterLevel(input),
        }),
    ],
    [
      "ReadHostFile",
      async (input) =>
        readFileCommand({
          path: requiredString(input, "path"),
          maxLines: optionalNumber(input, "maxLines"),
        }),
    ],
  ]);
}

const FILTER_LEVELS = ["err", "warn", "all"] as const;

function filterLevel(
  input: unknown,
): (typeof FILTER_LEVELS)[number] | undefined {
  const value = optionalString(input, "filterLevel");
  if (value === undefined) return undefined;
  const match = FILTER_LEVELS.find((l) => l === value);
  if (!match) {
    throw new Error(
      `"filterLevel" must be one of: ${FILTER_LEVELS.join(", ")}`,
    );
  }
  return match;
}
