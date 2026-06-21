import { hostname } from "node:os";
import type { CapabilityManifest } from "@nightwatch/shared";
import { getDocker } from "../docker-client.js";
import { getRunnerId } from "./identity.js";

const RUNNER_VERSION = "0.2.0";

export async function detectCapabilities(): Promise<CapabilityManifest> {
  const [docker, prometheusAvailable] = await Promise.all([
    detectDocker(),
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
      containers: docker.containers,
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
  containers: string[];
}> {
  try {
    const docker = getDocker();
    const list = await docker.listContainers({ all: false });
    const containers = list.map((c) => (c.Names[0] ?? "").replace(/^\//, ""));
    return { available: true, containers };
  } catch {
    return { available: false, containers: [] };
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
