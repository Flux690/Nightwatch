import "dotenv/config";
import type { IncidentRecord } from "@nightwatch/shared";
import {
  initDb,
  getRecentIncidents,
  insertIncident,
} from "./sqlite/history.js";
import { startWebSocketClient } from "./websocket/client.js";
import {
  getContainerList,
  getContainerLogs,
  getContainerInspect,
  getContainerStats,
  getContainerEvents,
  getContainerProcesses,
} from "./commands/container.js";
import {
  getHostMemory,
  getHostCpu,
  getHostDisk,
  getHostNetwork,
  getHostDmesg,
} from "./commands/host.js";
import {
  getRecentDeploys,
  getEnvVariableNames,
  readFileCommand,
} from "./commands/code.js";
import {
  restartContainer,
  rollbackDeploy,
  execCommand,
} from "./commands/remediation.js";
import { logger } from "./logger.js";

if (!process.env["NIGHTWATCH_TOKEN"]) {
  logger.fatal("NIGHTWATCH_TOKEN is required");
  process.exit(1);
}

initDb();

type Handler = (input: unknown) => Promise<unknown>;

const dispatch = new Map<string, Handler>([
  [
    "get_container_list",
    (i) => getContainerList(i as Parameters<typeof getContainerList>[0]),
  ],
  [
    "get_container_logs",
    (i) => getContainerLogs(i as Parameters<typeof getContainerLogs>[0]),
  ],
  [
    "get_container_inspect",
    (i) => getContainerInspect(i as Parameters<typeof getContainerInspect>[0]),
  ],
  [
    "get_container_stats",
    (i) => getContainerStats(i as Parameters<typeof getContainerStats>[0]),
  ],
  [
    "get_container_events",
    (i) => getContainerEvents(i as Parameters<typeof getContainerEvents>[0]),
  ],
  [
    "get_container_processes",
    (i) =>
      getContainerProcesses(i as Parameters<typeof getContainerProcesses>[0]),
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
    "get_recent_deploys",
    (i) => getRecentDeploys(i as Parameters<typeof getRecentDeploys>[0]),
  ],
  [
    "get_env_variable_names",
    (i) => getEnvVariableNames(i as Parameters<typeof getEnvVariableNames>[0]),
  ],
  [
    "read_file",
    (i) => readFileCommand(i as Parameters<typeof readFileCommand>[0]),
  ],
  [
    "restart_container",
    (i) => restartContainer(i as Parameters<typeof restartContainer>[0]),
  ],
  [
    "rollback_deploy",
    (i) => rollbackDeploy(i as Parameters<typeof rollbackDeploy>[0]),
  ],
  ["exec_command", (i) => execCommand(i as Parameters<typeof execCommand>[0])],
  [
    "get_incident_history",
    (i) => {
      const inp = i as {
        containerName?: string;
        alertType?: string;
        limitDays?: number;
      } | null;
      return Promise.resolve(
        getRecentIncidents(inp?.containerName, inp?.alertType, inp?.limitDays),
      );
    },
  ],
  [
    "write_incident",
    (i) => {
      insertIncident(i as IncidentRecord);
      return Promise.resolve({ written: true });
    },
  ],
]);

startWebSocketClient(dispatch);
logger.info("runner started");
