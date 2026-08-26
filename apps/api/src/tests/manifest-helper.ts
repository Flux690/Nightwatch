import {
  dockerServiceKey,
  type DockerServiceIdentity,
  kubernetesWorkloadKey,
  type DockerManifest,
  type DockerServiceEntry,
  type K8sWorkloadKind,
  type KubernetesManifest,
  type KubernetesWorkloadEntry,
} from "@nightwarden/shared";

export function manifest(
  hostname: string,
  services: DockerServiceEntry[] = [],
): DockerManifest {
  return {
    platform: "docker",
    hostname,
    runnerVersion: "3.0.0",
    services,
  };
}

export function kubernetesManifest(
  hostname: string,
  services: KubernetesWorkloadEntry[] = [],
): KubernetesManifest {
  return {
    platform: "kubernetes",
    hostname,
    runnerVersion: "3.0.0",
    services,
  };
}

// Anonymous-container convention (no Compose labels): project === service === name.
export function svc(name: string): DockerServiceIdentity {
  return { project: name, service: name };
}

export function dockerService(
  server: string,
  name: string,
): DockerServiceEntry {
  const identity = { project: name, service: name };
  return {
    identity,
    target: dockerServiceKey(server, identity),
    status: "running",
  };
}

export function kubernetesWorkload(
  server: string,
  namespace: string,
  workload: string,
  kind: K8sWorkloadKind = "Deployment",
): KubernetesWorkloadEntry {
  const identity = { namespace, workload };
  return {
    identity,
    target: kubernetesWorkloadKey(server, identity),
    status: "running",
    kind,
  };
}
