import { hostname } from "node:os";
import {
  deriveDockerServiceIdentity,
  serviceIdentityKey,
  type CapabilityManifest,
  type ServiceManifestEntry,
} from "@nightwarden/shared";
import { getDocker } from "../docker/client.js";
import { getAppsV1Api } from "../kubernetes/client.js";
import { isRemediationEnabled } from "../remediation-state.js";

const RUNNER_VERSION = "0.2.0";

export async function detectCapabilities(): Promise<CapabilityManifest> {
  const [docker, kubernetes] = await Promise.all([
    detectDocker(),
    detectKubernetes(),
  ]);

  return {
    hostname: hostname(),
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
      hostMetrics: true,
      fileRead: true,
      remediationEnabled: isRemediationEnabled(),
    },
  };
}

async function detectDocker(): Promise<{
  available: boolean;
  services: ServiceManifestEntry[];
}> {
  try {
    const docker = getDocker();
    // `all: true` so a service whose only container is currently stopped is still advertised - otherwise
    // routing would reject the call before the runner ever gets to JIT-resolve it and report a clean finding.
    const list = await docker.listContainers({ all: true });
    const server = process.env["NIGHTWARDEN_SERVER_NAME"];
    const byKey = new Map<string, ServiceManifestEntry>();
    for (const c of list) {
      const name = (c.Names[0] ?? "").replace(/^\//, "");
      const base = deriveDockerServiceIdentity(c.Labels, name);
      const identity = server ? { ...base, server } : base;
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
    const [deployments, statefulSets] = await Promise.all([
      appsApi.listDeploymentForAllNamespaces(),
      appsApi.listStatefulSetForAllNamespaces(),
    ]);

    // The cluster scope comes only from the operator-assigned env var, never the kubeconfig context name
    // (which drifts and wouldn't match the `cluster` label inbound alerts carry). Absent => an unscoped, single-cluster identity.
    const cluster = process.env["NIGHTWARDEN_CLUSTER_NAME"];
    const byKey = new Map<string, ServiceManifestEntry>();
    for (const item of [...deployments.items, ...statefulSets.items]) {
      const ns = item.metadata?.namespace ?? "default";
      const workload = item.metadata?.name ?? "";
      if (!workload) continue;
      // A workload with no ready replicas is advertised as stopped, not running,
      // so routing and the snapshot don't treat a scaled-to-0 service as up.
      const ready = (item.status?.readyReplicas ?? 0) > 0;
      byKey.set(`${ns}/${workload}`, {
        identity: {
          provider: "kubernetes",
          namespace: ns,
          workload,
          ...(cluster && { cluster }),
        },
        status: ready ? "running" : "stopped",
      });
    }
    return { available: true, services: [...byKey.values()] };
  } catch {
    return { available: false, services: [] };
  }
}
