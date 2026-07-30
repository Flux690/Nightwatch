export type AlertSeverity = "critical" | "warning" | "info";

// No target: an alert names no service on its own. `labels` is the whole input, and
// resolution asks the live fleet which advertised service they describe, so nothing
// speculative is ever stored.
export interface NormalizedAlert {
  sourceAlertId: string;
  labels: Record<string, string>;
  alertType: string;
  severity: AlertSeverity;
  firedAt: string;
  rawPayload: unknown;
}
