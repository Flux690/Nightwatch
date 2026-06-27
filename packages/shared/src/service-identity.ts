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
  // Optional execution sub-selector for a specific container in a multi-container
  // pod (sidecars). NOT part of the durable identity - excluded from
  // serviceIdentityKey - so two calls differing only by container key the same
  // service. Set only by the agent in a tool call, never derived from an alert.
  container?: string;
}

export type ServiceIdentity = DockerServiceIdentity | KubernetesServiceIdentity;

// Compose re-stamps these two labels on every recreate, so they survive a
// redeploy even though the container name/ID does not (docs/adr/0001).
// Anonymous `docker run` containers carry neither label; the only durable-ish
// handle available for them is their own live name, used for both fields.
//
// Label sources (in preference order):
//   1. "com.docker.compose.project" / "com.docker.compose.service": canonical
//      Docker Compose labels, usable by BYO monitoring that can attach
//      arbitrary key names.
//   2. "compose_project" / "compose_service": Prometheus-safe names produced
//      by the bundled metric_relabel_configs (dots are not valid Prometheus
//      label identifiers; cAdvisor exposes Docker labels as
//      container_label_com_docker_compose_project, which the relabel rule
//      renames to compose_project).
//
// "instance" (from Prometheus external_labels, set to the runner's hostname)
// populates the optional server scope so the identity is globally unique
// across the fleet and fleet-matching at ingest can distinguish servers.
export function deriveDockerServiceIdentity(
  labels: Record<string, string | undefined> | undefined,
  liveName: string,
): DockerServiceIdentity {
  const project =
    labels?.["com.docker.compose.project"] ?? labels?.["compose_project"];
  const service =
    labels?.["com.docker.compose.service"] ?? labels?.["compose_service"];
  const server = labels?.["instance"] || undefined;

  if (project && service) {
    return server
      ? { provider: "docker", project, service, server }
      : { provider: "docker", project, service };
  }
  return server
    ? { provider: "docker", project: liveName, service: liveName, server }
    : { provider: "docker", project: liveName, service: liveName };
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
  // The workload comes only from a controller label (deployment/statefulset) -
  // the durable handle the manifest advertises. When an alert carries only a
  // `pod` label we deliberately do NOT guess the workload from the pod name: a
  // Deployment pod (<name>-<rs-hash>-<rand>) and a StatefulSet pod (<name>-<n>)
  // are indistinguishable by shape, so stripping suffixes can mangle a multi-word
  // name into a DIFFERENT real workload and act on the wrong service. We pass the
  // pod name through verbatim instead; it will not match any advertised workload
  // key, so the alert is rejected loudly into the unresolved feed (ADR-0004) -
  // the correct signal that the alert is under-labelled.
  const workload =
    labels["deployment"] ?? labels["statefulset"] ?? labels["pod"] ?? "unknown";
  const cluster = labels["cluster"];
  return cluster
    ? { provider: "kubernetes", namespace, workload, cluster }
    : { provider: "kubernetes", namespace, workload };
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
