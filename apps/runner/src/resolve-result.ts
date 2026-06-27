import type { ServiceIdentity } from "@nightwatch/shared";

// A service identity resolved to nothing actionable (no workload, no running instance,
// ambiguous container). Shared by both resolvers and propagated verbatim, so
// "not running" is a finding, not an exception (ADR-0002).
export interface NoRunningInstanceResult {
  found: false;
  reason: string;
}

export function notRunningResult(
  service: ServiceIdentity,
  reason?: string,
): NoRunningInstanceResult {
  const label =
    service.provider === "kubernetes"
      ? `${service.namespace}/${service.workload}`
      : `${service.project}/${service.service}`;
  return {
    found: false,
    reason: reason ?? `No running instance found for ${label}`,
  };
}
