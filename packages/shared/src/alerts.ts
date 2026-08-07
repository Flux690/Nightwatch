export type AlertSeverity = "critical" | "warning" | "info";

// No target: an alert names no service on its own. `labels` is the whole input, and
// resolution asks the live fleet which advertised service they describe, so nothing
// speculative is ever stored.
export interface NormalizedAlert {
  sourceAlertId: string;
  labels: Record<string, string>;
  alertType: string;
  // Null when the label is absent or names a word we cannot rank; `labels` keeps
  // the operator's own word, which is the only verbatim record of it.
  severity: AlertSeverity | null;
  firedAt: string;
  rawPayload: unknown;
}
