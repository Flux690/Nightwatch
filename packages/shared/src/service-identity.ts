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
}

export type ServiceIdentity = DockerServiceIdentity | KubernetesServiceIdentity;

// Compose re-stamps these two labels on every recreate, so they survive a
// redeploy even though the container name/ID does not (docs/adr/0001).
// Anonymous `docker run` containers carry neither label; the only durable-ish
// handle available for them is their own live name, used for both fields.
export function deriveDockerServiceIdentity(
  labels: Record<string, string | undefined> | undefined,
  liveName: string,
): DockerServiceIdentity {
  const project = labels?.["com.docker.compose.project"];
  const service = labels?.["com.docker.compose.service"];
  if (project && service) {
    return { provider: "docker", project, service };
  }
  return { provider: "docker", project: liveName, service: liveName };
}

// Parses an inbound alert's labels into a candidate ServiceIdentity (ADR-0004
// resolve-or-reject): a guess to be matched against the fleet, never trusted
// on its own. `namespace` is a label Compose/cAdvisor alerts never carry, so
// its presence is the dispatch signal between the two provider shapes.
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
  const workload =
    labels["deployment"] ??
    labels["statefulset"] ??
    stripPodReplicaSuffix(labels["pod"] ?? "unknown");
  const cluster = labels["cluster"];
  return cluster
    ? { provider: "kubernetes", namespace, workload, cluster }
    : { provider: "kubernetes", namespace, workload };
}

// Best-effort recovery of the workload name from a bare pod name, used only
// when neither a `deployment` nor `statefulset` label is present. A
// Deployment's pod carries two generated segments (replicaset hash + pod
// suffix: myapp-7f8b9c-x4k2); a StatefulSet's pod carries one ordinal
// (myapp-0). Without either label there is no way to tell which shape we
// have, so this can misfire on a multi-word StatefulSet name - inherent to
// guessing from a pod name alone (ADR-0004).
function stripPodReplicaSuffix(pod: string): string {
  const parts = pod.split("-");
  if (parts.length >= 3) return parts.slice(0, -2).join("-");
  if (parts.length === 2) return parts.slice(0, -1).join("-");
  return pod;
}

// Canonical string form for equality/dedup/lookup and for rendering "known
// services" in error messages. Provider-prefixed so a Docker and a Kubernetes
// identity can never collide. When the server/cluster dimension is present it
// is inserted after the provider segment so scoped and unscoped keys can never
// collide (a scoped key always has one more path segment than an unscoped one).
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
