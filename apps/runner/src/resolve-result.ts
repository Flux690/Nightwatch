import type { ServiceIdentity } from "@nightwatch/shared";

// A service identity resolved to nothing actionable: no matching workload, no
// running instance when one is required, or an ambiguous container selection.
// Returned by both the Docker and Kubernetes resolvers and propagated verbatim
// by the command handlers, so a "not running" is a clean finding rather than an
// exception (ADR-0002).
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
