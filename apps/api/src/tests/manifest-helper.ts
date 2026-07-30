import type {
  CapabilityManifest,
  ServiceManifestEntry,
} from "@nightwarden/shared";

export function manifest(
  hostname: string,
  services: ServiceManifestEntry[] = [],
): CapabilityManifest {
  return {
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: true,
      kubernetes: false,
      services,
      postgres: { available: false },
      redis: { available: false },
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
