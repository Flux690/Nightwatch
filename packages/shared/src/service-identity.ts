export interface DockerServiceIdentity {
  provider: "docker";
  project: string;
  service: string;
}

export interface KubernetesServiceIdentity {
  provider: "kubernetes";
  namespace: string;
  workload: string;
  // Optional sub-selector for one container in a multi-container pod. NOT part of the durable
  // identity (excluded from the key), so calls differing only by container key the same service; set by the agent, never from an alert.
  container?: string;
}

export type ServiceIdentity = DockerServiceIdentity | KubernetesServiceIdentity;

// Lives here rather than in tools/kubernetes.ts because runner.ts needs it too and
// both already import from this file; the other direction would be a cycle.
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
  const compose = composeServiceLabels(labels);
  return compose !== null
    ? { provider: "docker", ...compose }
    : { provider: "docker", project: liveName, service: liveName };
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

// Canonical string for equality/dedup/lookup, provider-prefixed so Docker and Kubernetes can't
// collide. Always three segments: nothing an operator typed ever enters a key.
export function serviceIdentityKey(id: ServiceIdentity): string {
  return id.provider === "docker"
    ? `docker/${id.project}/${id.service}`
    : `kubernetes/${id.namespace}/${id.workload}`;
}
