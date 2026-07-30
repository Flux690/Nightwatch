// LLM tool payload types for the Docker tools. A Docker service is a container;
// nothing here describes a workload. Inputs carry the ServiceIdentity union because
// the wire is untrusted, and the runner's resolver narrows it at runtime.

import type { ServiceIdentity } from "../service-identity.js";
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

export interface DockerLogsInput {
  service: ServiceIdentity;
  tailLines?: number;
  sinceTimestamp?: string;
  stderrOnly?: boolean;
}
export interface DockerLogsResult {
  lines: string[];
  totalLines: number;
  droppedLines: number;
  compressionNote: string;
}

export interface DockerConfigInput {
  service: ServiceIdentity;
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
  service: ServiceIdentity;
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
  service: ServiceIdentity;
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
  service: ServiceIdentity;
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
  service: ServiceIdentity;
  delaySeconds?: number;
  rationale: string;
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
  service: ServiceIdentity;
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
