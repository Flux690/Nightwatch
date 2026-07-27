import { listRunners } from "../ws/fleet.js";
import type { FleetCapabilities } from "./tools/types.js";

// Run policy: which tools an investigation may use and on which providers, derived
// from the connected fleet; pure reads, recomputed each turn.

// Keyed on the whole fleet, not just the alerting runner. No runner connected -> both
// false (an integration-only session gets no Docker/K8s tools); connected but no manifest
// yet -> undefined (offer all for the handshake window); manifested -> what they advertise.
export function currentFleetCapabilities(): FleetCapabilities | undefined {
  const runners = listRunners();
  if (runners.length === 0) return { docker: false, kubernetes: false };
  let docker = false;
  let kubernetes = false;
  let anyManifest = false;
  for (const runner of runners) {
    if (!runner.manifest) continue;
    anyManifest = true;
    if (runner.manifest.capabilities.docker) docker = true;
    if (runner.manifest.capabilities.kubernetes) kubernetes = true;
  }
  return anyManifest ? { docker, kubernetes } : undefined;
}
