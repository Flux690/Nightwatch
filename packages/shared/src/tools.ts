// LLM tool input/output types — matched to Anthropic TOOL_SCHEMAS in apps/api

import type { ServiceIdentity } from "./service-identity.js";

export interface GetContainerListInput {
  environment: "docker" | "kubernetes";
  namespace?: string;
}
export interface ContainerInfo {
  name: string;
  id: string;
  service: ServiceIdentity;
  image: string;
  imageTag: string;
  status: string;
  restartCount: number;
  uptimeSeconds: number;
  healthStatus: string;
  exitCode?: number;
}

export interface GetContainerLogsInput {
  service: ServiceIdentity;
  tailLines?: number;
  sinceTimestamp?: string;
  stderrOnly?: boolean;
}
export interface ContainerLogsResult {
  lines: string[];
  totalLines: number;
  droppedLines: number;
  compressionNote: string;
}

export interface GetContainerInspectInput {
  service: ServiceIdentity;
}
export interface ContainerInspectResult {
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

export interface GetContainerStatsInput {
  service: ServiceIdentity;
}
export interface ContainerStatsResult {
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

export interface GetContainerEventsInput {
  service: ServiceIdentity;
  sinceMinutes?: number;
}
export interface ContainerEvent {
  timestamp: string;
  eventType:
    | "start"
    | "stop"
    | "restart"
    | "oom"
    | "die"
    | "health_status"
    | "pull"
    | "create"
    | "destroy";
  message: string;
  actor: string;
}

export interface GetContainerProcessesInput {
  service: ServiceIdentity;
}
export interface ContainerProcess {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  command: string;
}

export interface GetHostMemoryResult {
  totalBytes: number;
  availableBytes: number;
  usedPercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  oomKillerFiredRecently: boolean;
  oomKillerEvents: Array<{ timestamp: string; processName: string }>;
}

export interface GetHostCpuResult {
  cores: Array<{ id: number; usagePercent: number; iowaitPercent: number }>;
  loadAvg1m: number;
  loadAvg5m: number;
  loadAvg15m: number;
  overallCpuPercent: number;
  overallIowaitPercent: number;
}

export interface GetHostDiskResult {
  filesystems: Array<{
    mount: string;
    device: string;
    totalBytes: number;
    usedBytes: number;
    usedPercent: number;
  }>;
  diskIO: Array<{
    device: string;
    readBytesPerSec: number;
    writeBytesPerSec: number;
    iowaitPercent: number;
  }>;
}

export interface GetHostNetworkResult {
  listeningPorts: Array<{ port: number; protocol: string; process: string }>;
  connectionCounts: Array<{ state: string; count: number }>;
  totalConnections: number;
}

export interface GetHostDmesgInput {
  tailLines?: number;
  filterLevel?: "err" | "warn" | "all";
}
export interface GetHostDmesgResult {
  lines: Array<{ timestamp: string; level: string; message: string }>;
  oomEventsFound: boolean;
  fsErrorsFound: boolean;
}

export interface QueryPrometheusInput {
  query: string;
  startTime: string;
  endTime: string;
  step: string;
}
export interface PrometheusResult {
  metric: string;
  dataPoints: Array<{ timestamp: string; value: number }>;
  min: number;
  max: number;
  avg: number;
  firstAnomalyTimestamp?: string;
}

export interface GetAlertHistoryInput {
  service?: ServiceIdentity;
  limitDays?: number;
}

export interface GetRecentCommitsInput {
  repoOwner: string;
  repoName: string;
  branch?: string;
  limit?: number;
}
export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  timestamp: string;
  filesChanged: string[];
  additions: number;
  deletions: number;
}

export interface GetEnvVariableNamesInput {
  service: ServiceIdentity;
}
export interface ReadFileInput {
  path: string;
  maxLines?: number;
}
export interface ReadFileResult {
  content: string;
  lineCount: number;
  path: string;
  redactedLineCount: number;
}

export interface RequestClarificationInput {
  question: string;
  context: string;
}

export type RiskLevel = "low" | "medium" | "high";

export interface RestartContainerInput {
  service: ServiceIdentity;
  delaySeconds?: number;
  rationale: string;
  risk: RiskLevel;
  estimatedDowntimeSeconds: number;
}
export interface RestartContainerResult {
  success: boolean;
  startedAt: string;
  previousExitCode: number;
  newStatus: string;
}

// Kubernetes restart is a rollout restart (annotation patch), not a container
// restart, so it has no exit code or container status to report.
export interface RestartServiceK8sResult {
  success: boolean;
  startedAt: string;
  resourceKind: "Deployment" | "StatefulSet";
}

export interface ExecCommandInput {
  service: ServiceIdentity;
  command: string[];
  reason: string;
  risk: RiskLevel;
}
export interface ExecCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executedAt: string;
}

// Kubernetes-only: provider-specific tool (ADR-0002 providers hook). Not
// offered to Docker-only fleets.
export interface GetK8sRolloutStatusInput {
  service: ServiceIdentity;
}
