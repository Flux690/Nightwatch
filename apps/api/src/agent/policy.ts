import { addressName, listRunners } from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveByService } from "../ws/router.js";
import { getRemediationModeByRunnerRef } from "../db/runner.js";
import { toolSupportsProvider } from "./tools/toolset.js";
import type { Provider, Tool } from "./tools/types.js";

// Run policy: which tools an investigation may use and on which providers, derived
// from the connected fleet and DB-stored remediation mode; pure reads, recomputed each turn.

// Keyed on the whole fleet, not just the alerting runner - a mixed-fleet run may call
// agnostic tools on a sibling. Returns undefined (no filter) when no manifest has arrived.
export function currentFleetProviders(): ReadonlySet<Provider> | undefined {
  const providers = new Set<Provider>();
  for (const runner of listRunners()) {
    if (!runner.manifest) continue;
    if (runner.manifest.capabilities.docker) providers.add("docker");
    if (runner.manifest.capabilities.kubernetes) providers.add("kubernetes");
  }
  return providers.size > 0 ? providers : undefined;
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
    conn = resolveByService(input);
  } catch {
    return null;
  }
  // DB first (system of record, survives restarts), manifest as bootstrap.
  const dbMode = getRemediationModeByRunnerRef(conn.runnerId);
  const enabled =
    dbMode ?? conn.manifest?.capabilities.remediationEnabled ?? false;
  return enabled ? null : (addressName(conn) ?? conn.runnerId);
}

// Returns the service's provider when it doesn't match the tool's declared providers, so the
// model gets a corrective error instead of acting on the wrong provider.
export function mismatchedServiceProvider(
  input: Record<string, unknown>,
  entry: Tool,
): string | null {
  const service = input["service"];
  if (typeof service !== "object" || service === null) return null;
  const provider = (service as Record<string, unknown>)["provider"]; // typeof guard above confirms object shape
  if (typeof provider !== "string") return null;
  return toolSupportsProvider(entry, provider) ? null : provider;
}
