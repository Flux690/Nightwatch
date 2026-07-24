// LLM tool payload types for the service ops - matched to Anthropic
// TOOL_SCHEMAS in apps/api. One shape serves both providers; a type carries a
// provider prefix only where the providers genuinely diverge (restart).

import type { ServiceIdentity } from "../service-identity.js";

// The wire command name (ListDockerServices vs ListK8sWorkloads) selects the
// provider; namespace applies only to the Kubernetes list.
export interface ServiceListInput {
  namespace?: string;
}
export interface ServiceInstance {
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
export interface ServiceListResult {
  containers: ServiceInstance[];
}

export interface ServiceLogsInput {
  service: ServiceIdentity;
  tailLines?: number;
  sinceTimestamp?: string;
  stderrOnly?: boolean;
}
export interface ServiceLogsResult {
  lines: string[];
  totalLines: number;
  droppedLines: number;
  compressionNote: string;
}

export interface ServiceConfigInput {
  service: ServiceIdentity;
}
export interface ServiceConfigResult {
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

export interface ServiceStatsInput {
  service: ServiceIdentity;
}
export interface ServiceStatsResult {
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

export interface ServiceEventsInput {
  service: ServiceIdentity;
  sinceMinutes?: number;
}
export interface ServiceEvent {
  timestamp: string;
  eventType: string;
  message: string;
  actor: string;
}
export interface ServiceEventsResult {
  events: ServiceEvent[];
}

export interface ServiceProcessesInput {
  service: ServiceIdentity;
}
export interface ServiceProcess {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  command: string;
}
export interface ServiceProcessesResult {
  processes: ServiceProcess[];
}

export type RiskLevel = "low" | "medium" | "high";

export interface ServiceRestartInput {
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

// Kubernetes restart is a rollout restart (annotation patch), not a container
// restart, so it has no exit code or container status to report.
export interface K8sRestartResult {
  success: boolean;
  startedAt: string;
  resourceKind: "Deployment" | "StatefulSet";
}

export interface ServiceBashInput {
  service: ServiceIdentity;
  command: string[];
  reason: string;
  risk: RiskLevel;
}
export interface ServiceBashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executedAt: string;
}

// A service identity resolved to nothing actionable (no workload, no running
// instance, ambiguous container). Shared by both providers' resolvers and
// propagated verbatim, so "not running" is a finding, not an exception.
export interface NoRunningInstanceResult {
  found: false;
  reason: string;
}

export function notRunningResult(
  service: ServiceIdentity,
  reason?: string,
): NoRunningInstanceResult {
  const label =
    service.provider === "kubernetes"
      ? `${service.namespace}/${service.workload}`
      : `${service.project}/${service.service}`;
  return {
    found: false,
    reason: reason ?? `No running instance found for ${label}`,
  };
}
