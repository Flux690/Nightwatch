// LLM tool payload types for the Docker tools. A Docker service is a container;
// nothing here describes a workload, and no input can hold a Kubernetes identity.

import type { DockerServiceIdentity } from "../service-identity.js";
import type { RiskLevel } from "./common.js";

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

// since/until name the window's two edges, as the Docker API and kubectl both
// name them. ISO 8601 either way; absent means the engine's own default.

// contains/excludes are the caller's own filter, matched as plain text against
// whole lines. Neither engine can filter server-side, so somebody has to; this
// way it is the caller's intent rather than a guess made here.
export interface DockerLogsInput {
  service: DockerServiceIdentity;
  tailLines?: number;
  since?: string;
  until?: string;
  contains?: string[];
  excludes?: string[];
  stderrOnly?: boolean;
}
// A matched count means nothing without the size of what was searched: three
// hits in the newest hundred lines is not three hits in the log.
export interface DockerLogsResult {
  lines: string[];
  scannedLines: number;
  // The scan filled its tail, so older lines exist that it never looked at.
  scanHitTail: boolean;
  note: string;
}

export interface DockerConfigInput {
  service: DockerServiceIdentity;
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

export interface DockerStatsInput {
  service: DockerServiceIdentity;
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

export interface DockerEventsInput {
  service: DockerServiceIdentity;
  sinceMinutes?: number;
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

export interface DockerProcessesInput {
  service: DockerServiceIdentity;
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

export interface DockerRestartInput {
  service: DockerServiceIdentity;
  delaySeconds?: number;
  reason: string;
  risk: RiskLevel;
  estimatedDowntimeSeconds: number;
}
export interface DockerRestartResult {
  success: boolean;
  startedAt: string;
  previousExitCode: number;
  newStatus: string;
}

export interface DockerBashInput {
  service: DockerServiceIdentity;
  command: string[];
  reason: string;
  risk: RiskLevel;
}
export interface DockerBashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executedAt: string;
}
