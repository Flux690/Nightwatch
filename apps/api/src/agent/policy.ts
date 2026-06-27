import { getRunnerManifestForAlert, listRunners } from "../ws/router.js";
import { getRemediationModeByRunnerRef } from "../db/runner.js";
import { toolSupportsProvider } from "./tools.js";
import type { Provider, Tool } from "./tools.js";

// Run policy: which tools an investigation may use and on which providers. All
// derived from the connected fleet (WS state) and the DB-stored remediation
// mode; pure reads, recomputed once per run invocation by the loop.

// The providers filter (ADR-0002) is keyed on the whole fleet, not just the alerting
// runner - a mixed-fleet run may call agnostic tools on a sibling. Returns undefined (no
// filter) when no manifest has arrived, so a quiet fleet hides nothing.
export function currentFleetProviders(): ReadonlySet<Provider> | undefined {
  const providers = new Set<Provider>();
  for (const runner of listRunners()) {
    if (!runner.manifest) continue;
    if (runner.manifest.capabilities.docker) providers.add("docker");
    if (runner.manifest.capabilities.kubernetes) providers.add("kubernetes");
  }
  return providers.size > 0 ? providers : undefined;
}

// Remediation mode is the master write switch (ADR-0003), read from the DB (system of
// record), not a cache - so a run resumed after a restart sees the operator's setting
// pre-reconnect. Null DB falls back to the manifest; a chat session is on if any runner is.
export function currentRemediationEnabled(runnerId?: string): boolean {
  if (runnerId) {
    const dbMode = getRemediationModeByRunnerRef(runnerId);
    if (dbMode !== null) return dbMode;
    return (
      getRunnerManifestForAlert(runnerId)?.capabilities.remediationEnabled ??
      false
    );
  }
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

// Returns the service's provider when it doesn't match the tool's declared providers, so
// the model gets a corrective error instead of acting on the wrong provider (ADR-0002).
// Tools with no `service`, or a supported provider, never mismatch.
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
