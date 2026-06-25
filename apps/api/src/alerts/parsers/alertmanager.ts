import {
  deriveServiceIdentity,
  type NormalizedAlert,
} from "@nightwatch/shared";

interface AlertmanagerWebhook {
  alerts: Array<{
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
    fingerprint: string;
    status?: string;
  }>;
}

// An alert parsed from its source, carrying a candidate identity that has not
// yet been matched against the fleet (ADR-0004 resolve-or-reject) - runnerId
// and hostname are not yet known at parse time, so they are absent rather
// than guessed.
export type ParsedAlert = Omit<NormalizedAlert, "runnerId" | "hostname">;

export function parseAlertmanager(body: unknown): ParsedAlert[] {
  // body is unknown at the HTTP boundary; the array check right below is the
  // real validation, so the cast itself only narrows for the property access.
  const payload = body as AlertmanagerWebhook;
  if (!Array.isArray(payload?.alerts)) {
    throw new Error("Invalid Alertmanager payload: missing alerts array");
  }

  return payload.alerts.map((alert) => ({
    sourceAlertId: alert.fingerprint,
    targetIdentifier: deriveServiceIdentity(alert.labels),
    alertType: alert.labels["alertname"] ?? "unknown",
    severity: normalizeSeverity(alert.labels["severity"]),
    firedAt: alert.startsAt,
    rawPayload: alert,
  }));
}

function normalizeSeverity(s: string | undefined): NormalizedAlert["severity"] {
  if (s === "critical" || s === "error") return "critical";
  if (s === "warning" || s === "warn") return "warning";
  return "info";
}
