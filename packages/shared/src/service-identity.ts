// Two unrelated identities, not two arms of one union. A Docker runner can only
// ever hold the first and a Kubernetes runner only the second, so nothing narrows.

export interface DockerServiceIdentity {
  project: string;
  service: string;
}

export interface KubernetesWorkloadIdentity {
  namespace: string;
  workload: string;
  // Sub-selector for one container in a multi-container pod. NOT part of the durable
  // identity (excluded from the key), so calls differing only by container key the same
  // workload; set by the agent, never from an alert.
  container?: string;
}

export type K8sWorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";

// The Compose labels naming a durable service, or null when absent. Docker sets the
// dotted form; cAdvisor and Prometheus each re-render the same two labels their own
// way, so all three spellings are read.
export function composeServiceLabels(
  labels: Record<string, string | undefined> | undefined,
): { project: string; service: string } | null {
  const project = composeLabel(labels, "project");
  const service = composeLabel(labels, "service");
  return project !== undefined && service !== undefined
    ? { project, service }
    : null;
}

// Compose re-stamps the project/service labels on every recreate, so they outlive the container
// name/ID across a redeploy; anonymous `docker run` falls back to the live name.
export function deriveDockerServiceIdentity(
  labels: Record<string, string | undefined> | undefined,
  liveName: string,
): DockerServiceIdentity {
  return (
    composeServiceLabels(labels) ?? { project: liveName, service: liveName }
  );
}

function composeLabel(
  labels: Record<string, string | undefined> | undefined,
  field: "project" | "service",
): string | undefined {
  return (
    labels?.[`com.docker.compose.${field}`] ??
    labels?.[`compose_${field}`] ??
    labels?.[`container_label_com_docker_compose_${field}`]
  );
}

// Canonical address of one service, platform-prefixed so the two can never collide.
// Always three segments: nothing a user typed ever enters a key. Each platform
// builds its own, so neither function has a conditional in it.
export function dockerServiceKey(id: DockerServiceIdentity): string {
  return `docker/${id.project}/${id.service}`;
}

export function kubernetesWorkloadKey(id: KubernetesWorkloadIdentity): string {
  return `kubernetes/${id.namespace}/${id.workload}`;
}
