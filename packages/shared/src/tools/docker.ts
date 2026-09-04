// What the Docker tools answer with. Their inputs are schemas rather than types,
// so they live beside the validation in ../schemas/docker-commands.ts.

import type { LogLine } from "./common.js";

export interface DockerContainerInstance {
  name: string;
  id: string;
  // Flat identity key the agent echoes into a tool's `target` (serviceIdentityKey).
  target: string;
  image: string;
  imageTag: string;
  status: string;
  restartCount: number;
  uptimeSeconds: number;
  healthStatus: string;
  exitCode?: number;
}

// ListDockerServices takes no input: a Docker runner has exactly one host to list.
export interface DockerServiceListResult {
  containers: DockerContainerInstance[];
}

// A matched count means nothing without the size of what was searched: three
// hits in the newest hundred lines is not three hits in the log.
export interface DockerLogsResult {
  lines: LogLine[];
  scannedLines: number;
  // The scan filled its tail, so older lines exist that it never looked at.
  scanHitTail: boolean;
  note: string;
}

export interface DockerConfigResult {
  name: string;
  image: string;
  imageDigest: string;
  envVarNames: string[];
  mounts: unknown[];
  ports: unknown[];
  restartPolicy: string;
  healthCheck: {
    test: string[];
    interval: number;
    retries: number;
    lastResult: string;
  };
  createdAt: string;
  startedAt: string;
}

export interface DockerStatsResult {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}

export interface DockerEvent {
  timestamp: string;
  eventType: string;
  message: string;
  actor: string;
}
export interface DockerEventsResult {
  events: DockerEvent[];
}

export interface DockerProcess {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  command: string;
}
export interface DockerProcessesResult {
  processes: DockerProcess[];
}

export interface DockerRestartResult {
  success: boolean;
  startedAt: string;
  previousExitCode: number;
  newStatus: string;
}

export interface DockerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executedAt: string;
}
