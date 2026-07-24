import type { ServiceIdentity } from "./service-identity.js";

export type AlertSeverity = "critical" | "warning" | "info";

// No location fields: an alert is never pre-resolved to a runner. targetIdentifier is a candidate
// derived from the alert's labels, or null when they name no service. `labels` is the normalized
// label set the agent reads to identify an unresolved target itself. Misroute protection is the
// command validation.
export interface NormalizedAlert {
  sourceAlertId: string;
  targetIdentifier: ServiceIdentity | null;
  labels: Record<string, string>;
  alertType: string;
  severity: AlertSeverity;
  firedAt: string;
  rawPayload: unknown;
}
