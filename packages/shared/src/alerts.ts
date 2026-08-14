export type AlertSeverity = "critical" | "warning" | "info";

/* Every sender NightWarden mints a credential for. One row per kind, so an
   operator sees one card and one credential each; the kind decides which card
   and which status line, never how a body is parsed. */
export const ALERT_SOURCE_KINDS = ["alertmanager", "grafana"] as const;

export type AlertSourceKind = (typeof ALERT_SOURCE_KINDS)[number];

export function isAlertSourceKind(value: string): value is AlertSourceKind {
  return (ALERT_SOURCE_KINDS as readonly string[]).includes(value);
}

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

// What the sender said about the group a delivery carried, as opposed to about
// any one alert in it. Every field is optional on the wire, so an absent one is
// an empty map rather than a reason to reject the body.
export interface AlertGroupContext {
  // The labels the sender's own group_by resolved to, which is why these alerts
  // were delivered together.
  groupLabels: Record<string, string>;
  // Held by every alert in the group. The agent could intersect the labels
  // itself; the sender has already done it.
  commonLabels: Record<string, string>;
  commonAnnotations: Record<string, string>;
}

// Everything a delivery says about itself. Carried alongside the alerts rather
// than on them: these are facts about the envelope, and one more of them is a
// field here rather than another parameter down the chain.
export interface DeliveryContext {
  // How many alerts the sender left out. Zero means the group was sent whole.
  droppedAlerts: number;
  // Null when the sender supplied none of it.
  groupContext: AlertGroupContext | null;
}
