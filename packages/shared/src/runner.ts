import type { K8sWorkloadKind, ServiceIdentity } from "./service-identity.js";

// What a runner is, decided at onboarding and stored on its row. A runner serves
// exactly one of these; it is never probed, and never negotiated at runtime.
export type Platform = "docker" | "kubernetes";

export const PLATFORMS: readonly Platform[] = ["docker", "kubernetes"];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && PLATFORMS.some((p) => p === value);
}

export interface ServiceManifestEntry {
  identity: ServiceIdentity;
  status: string;
  // Kubernetes only. The runner knows it when it builds the manifest, and the
  // pod-name shape rules that resolve an alert are meaningless without it.
  kind?: K8sWorkloadKind;
}

export interface CapabilityManifest {
  hostname: string;
  runnerVersion: string;
  capabilities: {
    docker: boolean;
    kubernetes: boolean;
    services: ServiceManifestEntry[];
    postgres: { available: boolean; via?: string };
    redis: { available: boolean; via?: string };
  };
}

export interface RunnerRecord {
  id: string;
  token: string;
  platform: Platform;
  serverName: string | null;
  hostname: string | null;
  createdAt: string;
  online: boolean;
  lastSeen: string | null;
  manifest: CapabilityManifest | null;
}

// Live view of one connected runner for fleet reasoning: enough to match an alert or target identity.
// Unlike RunnerRecord it has no DB-only fields - derived entirely from WS state.
export interface FleetRunner {
  runnerId: string;
  // The model-visible address: operator-assigned server name, or the
  // self-reported hostname for legacy tokens minted without one.
  serverName: string | null;
  hostname: string;
  online: boolean;
  lastSeen: number;
  services: ServiceManifestEntry[];
}
