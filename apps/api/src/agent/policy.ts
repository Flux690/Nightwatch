import { addressName, listRunners } from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveByService } from "../ws/router.js";
import { getRemediationModeByRunnerRef } from "../db/runner.js";
import type { FleetCapabilities } from "./tools/types.js";

// Run policy: which tools an investigation may use and on which providers, derived
// from the connected fleet and DB-stored remediation mode; pure reads, recomputed each turn.

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

// Offering rule: write tools appear when ANY connected runner has remediation on.
// Which machine may actually be written to is decided per call by targetRemediationDisabled.
export function currentRemediationEnabled(): boolean {
  for (const runner of listRunners()) {
    if (runner.remediationMode === true) return true;
    if (
      runner.remediationMode === null &&
      runner.manifest?.capabilities.remediationEnabled
    )
      return true;
  }
  return false;
}

// Returns the target server's name when a write's target runner has remediation off, so
// callers reject before proposing or executing - mode is a property of the machine, not the session.
export function targetRemediationDisabled(
  input: Record<string, unknown>,
): string | null {
  let conn: RunnerConnection;
  try {
    conn = resolveByService(input).conn;
  } catch {
    return null;
  }
  // DB first (system of record, survives restarts), manifest as bootstrap.
  const dbMode = getRemediationModeByRunnerRef(conn.runnerId);
  const enabled =
    dbMode ?? conn.manifest?.capabilities.remediationEnabled ?? false;
  return enabled ? null : (addressName(conn) ?? conn.runnerId);
}
