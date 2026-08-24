// One list both ends compile against: the console draws by comparing a name,
// so a rename used to change its behaviour with nothing failing.
export const DOCKER_TOOL_NAMES = [
  "ListDockerServices",
  "GetDockerLogs",
  "GetDockerConfig",
  "GetDockerEvents",
  "GetDockerStats",
  "GetDockerProcesses",
  "RestartDockerService",
  "DockerBash",
  "GetHostCPU",
  "GetHostMemory",
  "GetHostDisk",
  "GetHostNetwork",
  "GetHostDmesg",
  "ReadHostFile",
] as const;

export const KUBERNETES_TOOL_NAMES = [
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
] as const;

/* Everything that runs inside the API and reaches no runner: what it queries,
   what it does to the connected repository, and what it writes to the record. */
const API_TOOL_NAMES = [
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

/* Composed, never typed a second time. Each runner owes handlers for its own
   group, which is what lets its registry be checked rather than described. */
export const TOOL_NAMES = [
  ...DOCKER_TOOL_NAMES,
  ...KUBERNETES_TOOL_NAMES,
  ...API_TOOL_NAMES,
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// `actual` stays a plain string, because a stored transcript holds retired
// names. The literal on our side is what is checked.
export function isTool(actual: string, ...names: readonly ToolName[]): boolean {
  return names.some((name) => name === actual);
}

/* Whether the build declares this name at all, which is not whether a turn
   offered it. A tool withheld for want of a runner and a name the model invented
   need different answers. */
export function isToolName(actual: string): actual is ToolName {
  return TOOL_NAMES.some((name) => name === actual);
}
