export type AlertSeverity = "critical" | "warning" | "info";

// No target: an alert names no service on its own. `labels` is the whole input, and
// resolution asks the live fleet which advertised service they describe, so nothing
// speculative is ever stored.
export interface NormalizedAlert {
  sourceAlertId: string;
  labels: Record<string, string>;
  // What a human wrote about this condition: summary, description, runbook_url.
  // Context only, so it enriches the prompt and never feeds a control decision.
  annotations: Record<string, string>;
  alertType: string;
  // Null when the label is absent or names a word we cannot rank; `labels` keeps
  // the user's own word, which is the only verbatim record of it.
  severity: AlertSeverity | null;
  firedAt: string;
  // Where the sender says the condition lives. Prometheus puts the expression that
  // fired in its query string; Grafana names a rule page and carries none.
  generatorURL: string | null;
  rawPayload: unknown;
}
