import type {
  CapabilityManifest,
  ServiceManifestEntry,
} from "@nightwatch/shared";

export function manifest(
  runnerId: string,
  hostname: string,
  services: ServiceManifestEntry[] = [],
): CapabilityManifest {
  return {
    runnerId,
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: true,
      kubernetes: false,
      services,
      prometheus: { available: false },
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: false,
      fileRead: false,
      remediationEnabled: false,
    },
  };
}

// Anonymous-container convention (no Compose labels): project === service === name.
export function dockerService(name: string): ServiceManifestEntry {
  return {
    identity: { provider: "docker", project: name, service: name },
    status: "running",
  };
}
