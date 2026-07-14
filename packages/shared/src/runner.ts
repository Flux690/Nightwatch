import type { ServiceIdentity } from "./service-identity.js";

export interface ServiceManifestEntry {
  identity: ServiceIdentity;
  status: string;
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
    hostMetrics: boolean;
    fileRead: boolean;
    remediationEnabled: boolean;
  };
}

export interface RunnerRecord {
  id: string;
  token: string;
  serverName: string | null;
  hostname: string | null;
  createdAt: string;
  online: boolean;
  lastSeen: string | null;
  manifest: CapabilityManifest | null;
  remediationMode: boolean | null;
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
  remediationEnabled: boolean;
}
