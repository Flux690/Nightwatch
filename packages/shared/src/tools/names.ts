/* Every tool the build declares, in one list both ends compile against. The
   console decides what to draw by comparing a name, and until this existed a
   rename on the API side changed the console's behaviour with nothing failing.
   The schemas themselves stay in apps/api; only the vocabulary is shared. */

export const TOOL_NAMES = [
  // Docker
  "ListDockerServices",
  "GetDockerLogs",
  "GetDockerConfig",
  "GetDockerEvents",
  "GetDockerStats",
  "GetDockerProcesses",
  "RestartDockerService",
  "DockerBash",
  // The host a Docker runner is 1:1 with
  "GetHostCPU",
  "GetHostMemory",
  "GetHostDisk",
  "GetHostNetwork",
  "GetHostDmesg",
  "ReadHostFile",
  // Kubernetes
  "ListK8sWorkloads",
  "GetK8sLogs",
  "GetK8sConfig",
  "GetK8sEvents",
  "GetK8sStats",
  "GetK8sProcesses",
  "GetK8sNodeStatus",
  "GetK8sRolloutStatus",
  "RestartK8sWorkload",
  "K8sBash",
  // Metrics
  "QueryMetrics",
  "QueryMetricsRange",
  "ListMetricNames",
  "GetMetricMetadata",
  "ListAlertRules",
  // Logs
  "QueryLogs",
  "QueryLogMetrics",
  "DiscoverLogLabels",
  // The connected repository, read and changed inside a sandbox
  "Read",
  "Edit",
  "Write",
  "Bash",
  "OpenPullRequest",
  "GetRecentChanges",
  // The record
  "RecordHypothesis",
  "SubmitInvestigationReport",
  // Asking a human is not a tool, but it is offered as one: tool-calling is the
  // only channel the model has to request anything.
  "AskUserQuestion",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/* Whether a recorded call is one of the named tools. `actual` stays a plain
   string on purpose - a stored transcript holds the names of tools that have
   since been renamed or retired, and it must still render. What is checked is
   the literal on our side: naming a tool the build no longer declares fails to
   compile, which is the whole point of the list. */
export function isTool(actual: string, ...names: readonly ToolName[]): boolean {
  return names.some((name) => name === actual);
}
