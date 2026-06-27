import { getRunnerManifestForAlert, listRunners } from "../ws/router.js";
import { getRemediationModeByRunnerRef } from "../db/runner.js";
import { toolSupportsProvider } from "./tools.js";
import type { Provider, Tool } from "./tools.js";

// Run policy: which tools an investigation may use and on which providers. All
// derived from the connected fleet (WS state) and the DB-stored remediation
// mode; pure reads, recomputed once per run invocation by the loop.

// The providers filter (ADR-0002) is keyed on the whole connected fleet, not
// just the alerting runner - a mixed-fleet investigation (user story 7) may
// still call agnostic tools against a sibling runner of either provider.
// Returns undefined (no filter, every tool shown) when no runner has reported
// a manifest yet, so a quiet fleet never hides tools the agent could need.
export function currentFleetProviders(): ReadonlySet<Provider> | undefined {
  const providers = new Set<Provider>();
  for (const runner of listRunners()) {
    if (!runner.manifest) continue;
    if (runner.manifest.capabilities.docker) providers.add("docker");
    if (runner.manifest.capabilities.kubernetes) providers.add("kubernetes");
  }
  return providers.size > 0 ? providers : undefined;
}

// Remediation mode is the master write switch (ADR-0003), and the API's DB is
// its system of record. We read the DB directly - not an in-memory cache - so a
// run resumed after an API restart sees the operator's setting even before the
// runner has reconnected (a stale/empty cache would otherwise flip a remediating
// run silently read-only). A null DB value (the runner has never been
// reconciled) falls back to the runner's live manifest self-report so a freshly
// added runner is not silently read-only. A chat session (no runner ref) is
// enabled when any connected runner has it on.
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

// Returns the service's provider string if it does not match the tool's
// declared providers (e.g. a Kubernetes-only tool called with a docker
// identity), so the model gets a corrective error instead of acting on the
// wrong provider (ADR-0002, user story 19). Tools with no `service` input,
// or a provider value the tool does support, are never mismatched.
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
