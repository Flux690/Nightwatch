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
// name/ID across a redeploy; anonymous `docker run` falls back to the live name. Server scope is added by each caller, never read from labels here.
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

// Parse an alert's labels into a candidate identity to match against the fleet, never trusted alone.
// `namespace` (which Compose/cAdvisor never carry) signals which of the two provider shapes it is.
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
  // The server scope comes only from the explicit `server` label - the same name the runner
  // advertises (NIGHTWATCH_SERVER_NAME); `instance` is Prometheus's built-in target address, never a fleet identity, so it's not consulted.
  const server = labels["server"];
  return server ? { ...base, server } : base;
}

function deriveKubernetesAlertIdentity(
  labels: Record<string, string | undefined>,
  namespace: string,
): KubernetesServiceIdentity {
  // Workload comes only from a controller label (the durable handle the manifest advertises); we don't
  // guess from a pod name since Deployment/StatefulSet pods are indistinguishable by shape - an under-labelled alert is rejected loudly.
  const workload =
    labels["deployment"] ?? labels["statefulset"] ?? labels["pod"] ?? "unknown";
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
