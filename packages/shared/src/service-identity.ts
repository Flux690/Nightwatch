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
  // Optional sub-selector for one container in a multi-container pod. NOT part of the
  // durable identity (excluded from the key), so calls differing only by container key the
  // same service; set by the agent, never from an alert.
  container?: string;
}

export type ServiceIdentity = DockerServiceIdentity | KubernetesServiceIdentity;

// Compose re-stamps the project/service labels on every recreate, so they outlive the
// container name/ID across a redeploy (ADR-0001); anonymous `docker run` falls back to
// the live name. The server scope is added by each caller, never read from labels here.
export function deriveDockerServiceIdentity(
  labels: Record<string, string | undefined> | undefined,
  liveName: string,
): DockerServiceIdentity {
  const project =
    labels?.["com.docker.compose.project"] ?? labels?.["compose_project"];
  const service =
    labels?.["com.docker.compose.service"] ?? labels?.["compose_service"];

  return project && service
    ? { provider: "docker", project, service }
    : { provider: "docker", project: liveName, service: liveName };
}

// Parse an alert's labels into a candidate identity to match against the fleet (ADR-0004),
// never trusted alone. `namespace` (which Compose/cAdvisor never carry) signals which of
// the two provider shapes it is.
export function deriveServiceIdentity(
  labels: Record<string, string | undefined> | undefined,
): ServiceIdentity {
  const l = labels ?? {};
  const namespace = l["namespace"];
  return typeof namespace === "string"
    ? deriveKubernetesAlertIdentity(l, namespace)
    : deriveDockerAlertIdentity(l);
}

function deriveDockerAlertIdentity(
  labels: Record<string, string | undefined>,
): DockerServiceIdentity {
  // `name` is what cAdvisor sets and what our shipped rules.yml alerts carry
  // ({{ $labels.name }}); the rest are fallbacks for other alert sources.
  const liveName =
    labels["name"] ??
    labels["container"] ??
    labels["service"] ??
    labels["job"] ??
    "unknown";
  const base = deriveDockerServiceIdentity(labels, liveName);
  const server = labels["instance"] ?? labels["hostname"];
  return server ? { ...base, server } : base;
}

function deriveKubernetesAlertIdentity(
  labels: Record<string, string | undefined>,
  namespace: string,
): KubernetesServiceIdentity {
  // Workload comes only from a controller label (the durable handle the manifest advertises).
  // We don't guess it from a pod name - Deployment and StatefulSet pods are indistinguishable
  // by shape - so an under-labelled alert matches nothing and is rejected loudly (ADR-0004).
  const workload =
    labels["deployment"] ?? labels["statefulset"] ?? labels["pod"] ?? "unknown";
  const cluster = labels["cluster"];
  return cluster
    ? { provider: "kubernetes", namespace, workload, cluster }
    : { provider: "kubernetes", namespace, workload };
}

// Canonical string for equality/dedup/lookup, provider-prefixed so Docker and Kubernetes
// can't collide. The server/cluster scope, when present, is inserted after the provider so
// a scoped key always has one more segment than an unscoped one.
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
