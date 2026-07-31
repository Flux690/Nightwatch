// LLM tool payload types for the Kubernetes tools - matched to the tool schemas in
// apps/api. A Kubernetes workload is not a container: every result identifies the
// pod it was read from, and every read reports names and shapes, never secret values.

import type {
  K8sWorkloadKind,
  KubernetesWorkloadIdentity,
} from "../service-identity.js";
import type { RiskLevel } from "./common.js";

export interface K8sWorkloadListInput {
  namespace?: string;
}

export interface K8sWorkloadInstance {
  name: string;
  kind: K8sWorkloadKind;
  namespace: string;
  // Flat identity key the agent echoes into a tool's `target` (serviceIdentityKey).
  target: string;
  uid: string;
  image: string;
  imageTag: string;
  desiredReplicas: number;
  readyReplicas: number;
  updatedReplicas: number;
  availableReplicas: number;
  status: "Healthy" | "Degraded" | "Progressing" | "ScaledToZero";
  generation: number;
  observedGeneration: number;
}

export interface K8sWorkloadListResult {
  workloads: K8sWorkloadInstance[];
}

// No stderrOnly: the Kubernetes log API merges the streams and cannot filter them.
export interface K8sLogsInput {
  service: KubernetesWorkloadIdentity;
  tailLines?: number;
  sinceTimestamp?: string;
}
export interface K8sLogsResult {
  lines: string[];
  totalLines: number;
  podName: string;
  containerName: string | null;
  podPhase: string;
  // True when the read came from the terminated container of a crash loop.
  fromPreviousContainer: boolean;
}

export interface K8sProbe {
  kind: "liveness" | "readiness" | "startup";
  type: "http" | "tcp" | "exec" | "grpc";
  detail: string;
  initialDelaySeconds: number;
  periodSeconds: number;
  timeoutSeconds: number;
  failureThreshold: number;
  successThreshold: number;
}

export interface K8sContainerSpec {
  name: string;
  image: string;
  // Only a running pod's containerStatuses carries a digest; null when nothing runs.
  imageDigest: string | null;
  envVarNames: string[];
  // ConfigMap and Secret names only: contents are never read, so a config read
  // cannot leak a credential.
  envFromSources: string[];
  cpuRequest: string | null;
  cpuLimit: string | null;
  memoryRequest: string | null;
  memoryLimit: string | null;
  probes: K8sProbe[];
  volumeMounts: Array<{ name: string; mountPath: string; readOnly: boolean }>;
}

export interface K8sConfigInput {
  service: KubernetesWorkloadIdentity;
}
export interface K8sConfigResult {
  name: string;
  kind: K8sWorkloadKind;
  namespace: string;
  createdAt: string;
  generation: number;
  observedGeneration: number;
  desiredReplicas: number;
  strategy: {
    type: string;
    maxSurge: string | null;
    maxUnavailable: string | null;
  };
  selector: Record<string, string>;
  serviceAccountName: string | null;
  nodeSelector: Record<string, string>;
  containers: K8sContainerSpec[];
  volumes: Array<{ name: string; kind: string }>;
}

export interface K8sStatsInput {
  service: KubernetesWorkloadIdentity;
}

export interface K8sContainerStats {
  name: string;
  cpuMillicores: number | null;
  memoryBytes: number | null;
  cpuRequestMillicores: number | null;
  cpuLimitMillicores: number | null;
  memoryRequestBytes: number | null;
  memoryLimitBytes: number | null;
  restartCount: number;
  // "OOMKilled" here is the answer to a whole class of investigation.
  lastTerminationReason: string | null;
  lastTerminationExitCode: number | null;
}

export interface K8sPodStats {
  podName: string;
  phase: string;
  nodeName: string | null;
  startedAt: string | null;
  containers: K8sContainerStats[];
}

// Every pod of the workload, capped: one crash-looping replica among three healthy
// ones is the finding, so a single-pod reading would hide it.
export interface K8sStatsResult {
  workload: string;
  namespace: string;
  // False when metrics-server is not installed; usage fields are then null and the
  // requests, limits and restart counts still carry.
  metricsAvailable: boolean;
  pods: K8sPodStats[];
  podsOmitted?: number;
}

export interface K8sEventsInput {
  service: KubernetesWorkloadIdentity;
  sinceMinutes?: number;
  // Kubernetes Normal events are high-volume; default true.
  warningsOnly?: boolean;
}

export interface K8sEvent {
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  count: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  involvedObject: { kind: string; name: string; namespace: string };
  reportingComponent: string | null;
}

export interface K8sEventsResult {
  workload: string;
  namespace: string;
  // The workload's own events plus its pods', oldest first.
  events: K8sEvent[];
  eventsOmitted?: number;
  warningsOnly: boolean;
}

export interface K8sProcess {
  pid: number;
  ppid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  command: string;
}

export interface K8sProcessesInput {
  service: KubernetesWorkloadIdentity;
}
export interface K8sProcessesResult {
  podName: string;
  containerName: string | null;
  processes: K8sProcess[];
}

// No delaySeconds: a rollout restart is an annotation patch with no delay to honour.
export interface K8sRestartInput {
  service: KubernetesWorkloadIdentity;
  reason: string;
  risk: RiskLevel;
  estimatedDowntimeSeconds: number;
}
export interface K8sRestartResult {
  success: boolean;
  startedAt: string;
  kind: K8sWorkloadKind;
  generation: number;
}

export interface K8sRolloutStatusInput {
  service: KubernetesWorkloadIdentity;
}
export interface K8sRolloutStatusResult {
  workload: string;
  namespace: string;
  kind: K8sWorkloadKind;
  complete: boolean;
  reason: string;
  desiredReplicas: number;
  updatedReplicas: number;
  readyReplicas: number;
  availableReplicas: number;
  generation: number;
  observedGeneration: number;
  // StatefulSet status alone carries revisions; null for the other two kinds.
  currentRevision: string | null;
  updateRevision: string | null;
  conditions: Array<{
    type: string;
    status: string;
    reason: string;
    message: string;
    lastTransitionTime: string | null;
  }>;
}

export interface K8sBashInput {
  service: KubernetesWorkloadIdentity;
  command: string[];
  reason: string;
  risk: RiskLevel;
}
export interface K8sBashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executedAt: string;
  podName: string;
  containerName: string | null;
}

export interface K8sNodeCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason: string | null;
  message: string | null;
  lastTransitionTime: string | null;
}

export interface K8sNode {
  name: string;
  ready: boolean;
  unschedulable: boolean;
  conditions: K8sNodeCondition[];
  allocatable: { cpu: string; memory: string; pods: string };
  capacity: { cpu: string; memory: string; pods: string };
  kubeletVersion: string | null;
}

// Node pressure is a node fact, not a per-workload one, so the input is empty and
// the result carries no service identity.
export interface K8sNodeStatusResult {
  nodes: K8sNode[];
}
