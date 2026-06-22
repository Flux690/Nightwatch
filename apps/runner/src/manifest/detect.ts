import { hostname } from "node:os";
import {
  deriveDockerServiceIdentity,
  serviceIdentityKey,
  type CapabilityManifest,
  type ServiceIdentity,
} from "@nightwatch/shared";
import { getDocker } from "../docker-client.js";
import { getAppsV1Api } from "../kubernetes-client.js";
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
  services: ServiceIdentity[];
}> {
  try {
    const docker = getDocker();
    // `all: true` so a service whose only container is currently stopped is
    // still advertised - otherwise routing would reject the call before the
    // runner ever gets to JIT-resolve it and report a clean finding.
    const list = await docker.listContainers({ all: true });
    const byKey = new Map<string, ServiceIdentity>();
    for (const c of list) {
      const name = (c.Names[0] ?? "").replace(/^\//, "");
      const identity = deriveDockerServiceIdentity(c.Labels, name);
      byKey.set(serviceIdentityKey(identity), identity);
    }
    return { available: true, services: [...byKey.values()] };
  } catch {
    return { available: false, services: [] };
  }
}

async function detectKubernetes(): Promise<{
  available: boolean;
  services: ServiceIdentity[];
}> {
  try {
    const appsApi = getAppsV1Api();
    const [deployments, statefulSets] = await Promise.all([
      appsApi.listDeploymentForAllNamespaces(),
      appsApi.listStatefulSetForAllNamespaces(),
    ]);

    const byKey = new Map<string, ServiceIdentity>();
    for (const item of [...deployments.items, ...statefulSets.items]) {
      const ns = item.metadata?.namespace ?? "default";
      const workload = item.metadata?.name ?? "";
      if (!workload) continue;
      byKey.set(`${ns}/${workload}`, { provider: "kubernetes", namespace: ns, workload });
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
