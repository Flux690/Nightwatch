// LLM tool input/output types — matched to Anthropic TOOL_SCHEMAS in apps/api

export interface GetContainerListInput {
  environment: "docker" | "kubernetes";
  namespace?: string;
}
export interface ContainerInfo {
  name: string;
  id: string;
  image: string;
  imageTag: string;
  status: string;
  restartCount: number;
  uptimeSeconds: number;
  healthStatus: string;
  exitCode?: number;
}

export interface GetContainerLogsInput {
  containerName: string;
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
  containerName: string;
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
  containerName: string;
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
  containerName: string;
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
  containerName: string;
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
  containerName?: string;
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

export interface GetRecentDeploysInput {
  containerName: string;
}
export interface DeployInfo {
  currentImageDigest: string;
  currentImageCreatedAt: string;
  previousImageDigest?: string;
  imageChangedAt?: string;
  timeSinceChangeMinutes?: number;
}

export interface GetEnvVariableNamesInput {
  containerName: string;
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
  containerName: string;
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

export interface RollbackDeployInput {
  containerName: string;
  targetImageDigest: string;
  rationale: string;
  risk: RiskLevel;
  estimatedDowntimeSeconds: number;
}
export interface RollbackDeployResult {
  success: boolean;
  previousImage: string;
  newImage: string;
  restartedAt: string;
}

export interface ExecCommandInput {
  containerName: string;
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
