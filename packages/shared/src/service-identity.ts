export interface DockerServiceIdentity {
  provider: "docker";
  project: string;
  service: string;
  server?: string;
}

export interface KubernetesServiceIdentity {
  provider: "kubernetes";
  namespace: string;
  workload: string;
  cluster?: string;
  // Optional sub-selector for one container in a multi-container pod. NOT part of the durable
  // identity (excluded from the key), so calls differing only by container key the same service; set by the agent, never from an alert.
  container?: string;
}

export type ServiceIdentity = DockerServiceIdentity | KubernetesServiceIdentity;

// Compose re-stamps the project/service labels on every recreate, so they outlive the container
// name/ID across a redeploy; anonymous `docker run` falls back to the live name. The `container_label_`
// prefix is cAdvisor's rendering of the same labels. Server scope is added by each caller.
export function deriveDockerServiceIdentity(
  labels: Record<string, string | undefined> | undefined,
  liveName: string,
): DockerServiceIdentity {
  const project = composeLabel(labels, "project");
  const service = composeLabel(labels, "service");

  return project && service
    ? { provider: "docker", project, service }
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

// Parse an alert's labels into a candidate identity to match against the fleet, never trusted alone.
// `namespace` (which Docker/Compose alerts never carry) signals which of the two provider shapes it is;
// null means the labels name no service.
export function deriveServiceIdentity(
  labels: Record<string, string | undefined> | undefined,
): ServiceIdentity | null {
  const l = labels ?? {};
  const namespace = l["namespace"];
  return typeof namespace === "string"
    ? deriveKubernetesAlertIdentity(l, namespace)
    : deriveDockerAlertIdentity(l);
}

function deriveDockerAlertIdentity(
  labels: Record<string, string | undefined>,
): DockerServiceIdentity | null {
  // Compose labels name the durable service; else the live container name cAdvisor sets.
  // No compose labels and no container name means nothing to identify - null, not a guess.
  const hasCompose =
    composeLabel(labels, "project") !== undefined &&
    composeLabel(labels, "service") !== undefined;
  const liveName = labels["name"] ?? labels["container"];
  if (!hasCompose && liveName === undefined) return null;
  const base = deriveDockerServiceIdentity(labels, liveName ?? "unknown");
  // Only the explicit `nw_server` label (the name the runner advertises) scopes the identity.
  // Namespaced because foreign tools own the generic words: postgres_exporter's `server` is a db address.
  const server = labels["nw_server"];
  return server ? { ...base, server } : base;
}

function deriveKubernetesAlertIdentity(
  labels: Record<string, string | undefined>,
  namespace: string,
): KubernetesServiceIdentity | null {
  // Workload comes only from a controller/pod label (we don't strip pod suffixes - Deployment and
  // StatefulSet pods are indistinguishable by shape). Absent means nothing to identify - null.
  const workload =
    labels["deployment"] ?? labels["statefulset"] ?? labels["pod"];
  if (workload === undefined) return null;
  const cluster = labels["cluster"];
  return cluster
    ? { provider: "kubernetes", namespace, workload, cluster }
    : { provider: "kubernetes", namespace, workload };
}

// Canonical string for equality/dedup/lookup, provider-prefixed so Docker and Kubernetes can't collide.
// The server/cluster scope, when present, is inserted after the provider so a scoped key always has one more segment than an unscoped one.
export function serviceIdentityKey(id: ServiceIdentity): string {
  if (id.provider === "docker") {
    return id.server
      ? `docker/${id.server}/${id.project}/${id.service}`
      : `docker/${id.project}/${id.service}`;
  }
  return id.cluster
    ? `kubernetes/${id.cluster}/${id.namespace}/${id.workload}`
    : `kubernetes/${id.namespace}/${id.workload}`;
}
