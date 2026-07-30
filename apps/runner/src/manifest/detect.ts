import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import {
  deriveDockerServiceIdentity,
  serviceIdentityKey,
  type CapabilityManifest,
  type K8sWorkloadKind,
  type ServiceManifestEntry,
} from "@nightwarden/shared";
import { getDocker, listVisibleContainers } from "../docker/client.js";
import { getAppsV1Api } from "../kubernetes/client.js";
import { PROC_PATH } from "../commands/host.js";

const RUNNER_VERSION = "0.2.0";

export async function detectCapabilities(): Promise<CapabilityManifest> {
  const [host, docker, kubernetes] = await Promise.all([
    detectHostname(),
    detectDocker(),
    detectKubernetes(),
  ]);

  return {
    hostname: host,
    runnerVersion: RUNNER_VERSION,
    capabilities: {
      docker: docker.available,
      kubernetes: kubernetes.available,
      services: [...docker.services, ...kubernetes.services],
      postgres: process.env["POSTGRES_URL"]
        ? { available: true, via: "connection_string" }
        : { available: false },
      redis: process.env["REDIS_URL"]
        ? { available: true, via: "connection_string" }
        : { available: false },
    },
  };
}

// os.hostname() inside a container is the container id unless --hostname was passed,
// and this string becomes the address the model types into `runner`. Host /proc is
// already mounted for the host metrics, so the real name costs no new mount.
async function detectHostname(): Promise<string> {
  try {
    const name = (
      await readFile(`${PROC_PATH}/sys/kernel/hostname`, "utf8")
    ).trim();
    if (name) return name;
  } catch {
    // Not containerized, or /proc is not readable: the OS name is already correct.
  }
  return hostname();
}

async function detectDocker(): Promise<{
  available: boolean;
  services: ServiceManifestEntry[];
}> {
  try {
    const docker = getDocker();
    // `all: true` so a service whose only container is currently stopped is still advertised - otherwise
    // routing would reject the call before the runner ever gets to JIT-resolve it and report a clean finding.
    const list = await listVisibleContainers(docker);
    const byKey = new Map<string, ServiceManifestEntry>();
    for (const c of list) {
      const name = (c.Names[0] ?? "").replace(/^\//, "");
      const identity = deriveDockerServiceIdentity(c.Labels, name);
      const key = serviceIdentityKey(identity);
      const existing = byKey.get(key);
      // Prefer "running" over any stopped state when multiple containers share an identity (e.g. scaled
      // Compose replicas or a restarted container that left a stopped predecessor in the list).
      if (!existing || existing.status !== "running") {
        byKey.set(key, { identity, status: c.State });
      }
    }
    return { available: true, services: [...byKey.values()] };
  } catch {
    return { available: false, services: [] };
  }
}

async function detectKubernetes(): Promise<{
  available: boolean;
  services: ServiceManifestEntry[];
}> {
  try {
    const appsApi = getAppsV1Api();
    const [deployments, statefulSets, daemonSets] = await Promise.all([
      appsApi.listDeploymentForAllNamespaces(),
      appsApi.listStatefulSetForAllNamespaces(),
      appsApi.listDaemonSetForAllNamespaces(),
    ]);

    // The three kinds report readiness under different names, so the manifest reads
    // only the fields all three share plus each one's own readiness count.
    interface WorkloadListing {
      metadata?: { namespace?: string; name?: string };
      status?: { readyReplicas?: number; numberReady?: number };
    }
    const kinds: Array<[K8sWorkloadKind, WorkloadListing[]]> = [
      ["Deployment", deployments.items],
      ["StatefulSet", statefulSets.items],
      ["DaemonSet", daemonSets.items],
    ];

    const byKey = new Map<string, ServiceManifestEntry>();
    for (const [kind, items] of kinds) {
      for (const item of items) {
        const ns = item.metadata?.namespace ?? "default";
        const workload = item.metadata?.name ?? "";
        if (!workload) continue;
        // A workload with nothing ready is advertised as stopped, not running, so
        // routing and the snapshot don't treat a scaled-to-0 service as up. A
        // DaemonSet counts nodes, so its readiness lives under another name.
        const ready =
          (item.status?.readyReplicas ?? item.status?.numberReady ?? 0) > 0;
        byKey.set(`${ns}/${workload}`, {
          identity: { provider: "kubernetes", namespace: ns, workload },
          status: ready ? "running" : "stopped",
          // The alert resolver's pod-name shape rules are statements about a kind,
          // so an entry without one can only ever be matched exactly.
          kind,
        });
      }
    }
    return { available: true, services: [...byKey.values()] };
  } catch {
    return { available: false, services: [] };
  }
}
