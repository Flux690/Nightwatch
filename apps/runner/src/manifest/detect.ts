import { hostname } from "node:os";
import {
  deriveDockerServiceIdentity,
  serviceIdentityKey,
  type CapabilityManifest,
  type ServiceManifestEntry,
} from "@nightwatch/shared";
import { getDocker } from "../docker-client.js";
import { getAppsV1Api, getClusterName } from "../kubernetes-client.js";
import { getRunnerId } from "./identity.js";

const RUNNER_VERSION = "0.2.0";

export async function detectCapabilities(): Promise<CapabilityManifest> {
  const [docker, kubernetes, prometheusAvailable] = await Promise.all([
    detectDocker(),
    detectKubernetes(),
    detectPrometheus(),
  ]);

  const prometheusEndpoint =
    process.env["PROMETHEUS_URL"] ?? "http://localhost:9090";

  return {
    runnerId: getRunnerId(),
    hostname: hostname(),
    runnerVersion: RUNNER_VERSION,
    capabilities: {
      docker: docker.available,
      kubernetes: kubernetes.available,
      services: [...docker.services, ...kubernetes.services],
      prometheus: prometheusAvailable
        ? { available: true, endpoint: prometheusEndpoint }
        : { available: false },
      postgres: process.env["POSTGRES_URL"]
        ? { available: true, via: "connection_string" }
        : { available: false },
      redis: process.env["REDIS_URL"]
        ? { available: true, via: "connection_string" }
        : { available: false },
      hostMetrics: true,
      fileRead: true,
      remediationEnabled: process.env["REMEDIATION_ENABLED"] === "true",
    },
  };
}

async function detectDocker(): Promise<{
  available: boolean;
  services: ServiceManifestEntry[];
}> {
  try {
    const docker = getDocker();
    // `all: true` so a service whose only container is currently stopped is
    // still advertised - otherwise routing would reject the call before the
    // runner ever gets to JIT-resolve it and report a clean finding.
    const list = await docker.listContainers({ all: true });
    const server = process.env["NIGHTWATCH_SERVER_NAME"];
    const byKey = new Map<string, ServiceManifestEntry>();
    for (const c of list) {
      const name = (c.Names[0] ?? "").replace(/^\//, "");
      const base = deriveDockerServiceIdentity(c.Labels, name);
      const identity = server ? { ...base, server } : base;
      const key = serviceIdentityKey(identity);
      const existing = byKey.get(key);
      // Prefer "running" over any stopped state when multiple containers share
      // an identity (e.g. scaled Compose replicas or a restarted container
      // that left a stopped predecessor in the list).
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

    const cluster = process.env["NIGHTWATCH_CLUSTER_NAME"] ?? getClusterName();
    const byKey = new Map<string, ServiceManifestEntry>();
    for (const item of [...deployments.items, ...statefulSets.items]) {
      const ns = item.metadata?.namespace ?? "default";
      const workload = item.metadata?.name ?? "";
      if (!workload) continue;
      byKey.set(`${ns}/${workload}`, {
        identity: { provider: "kubernetes", namespace: ns, workload, cluster },
        status: "running",
      });
    }
    return { available: true, services: [...byKey.values()] };
  } catch {
    return { available: false, services: [] };
  }
}

async function detectPrometheus(): Promise<boolean> {
  try {
    const url = process.env["PROMETHEUS_URL"] ?? "http://localhost:9090";
    const res = await fetch(`${url}/-/healthy`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
