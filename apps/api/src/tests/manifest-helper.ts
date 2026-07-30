import {
  dockerServiceKey,
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
export function dockerService(name: string): DockerServiceEntry {
  const identity = { project: name, service: name };
  return {
    identity,
    target: dockerServiceKey(identity),
    status: "running",
  };
}

export function kubernetesWorkload(
  namespace: string,
  workload: string,
  kind: K8sWorkloadKind = "Deployment",
): KubernetesWorkloadEntry {
  const identity = { namespace, workload };
  return {
    identity,
    target: kubernetesWorkloadKey(identity),
    status: "running",
    kind,
  };
}
