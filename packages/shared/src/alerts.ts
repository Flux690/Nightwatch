import type { ServiceIdentity } from "./service-identity.js";

export type AlertSeverity = "critical" | "warning" | "info";

// No location fields: an alert is never pre-resolved to a runner. The agent
// derives the target's location from the fleet map, and service-routed
// command validation is what prevents misrouted actions.
export interface NormalizedAlert {
  sourceAlertId: string;
  targetIdentifier: ServiceIdentity;
  alertType: string;
  severity: AlertSeverity;
  firedAt: string;
  rawPayload: unknown;
}
