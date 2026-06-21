export interface DockerServiceIdentity {
  provider: "docker";
  project: string;
  service: string;
}

export interface KubernetesServiceIdentity {
  provider: "kubernetes";
  namespace: string;
  workload: string;
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

// Canonical string form for equality/dedup/lookup and for rendering "known
// services" in error messages. Provider-prefixed so a Docker and a Kubernetes
// identity can never collide.
export function serviceIdentityKey(id: ServiceIdentity): string {
  return id.provider === "docker"
    ? `docker/${id.project}/${id.service}`
    : `kubernetes/${id.namespace}/${id.workload}`;
}
