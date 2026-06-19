import type { NormalizedAlert } from "@nightwatch/shared";

interface AlertmanagerWebhook {
  alerts: Array<{
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
    fingerprint: string;
    status?: string;
  }>;
}

export function parseAlertmanager(
  body: unknown,
  runnerId: string,
  hostname?: string,
): NormalizedAlert[] {
  const payload = body as AlertmanagerWebhook;
  if (!Array.isArray(payload?.alerts)) {
    throw new Error("Invalid Alertmanager payload: missing alerts array");
  }

  return payload.alerts.map((alert) => ({
    sourceAlertId: alert.fingerprint,
    runnerId,
    ...(hostname !== undefined && { hostname }),
    // `name` is what cAdvisor sets and what our shipped rules.yml alerts carry
    // ({{ $labels.name }}); the rest are fallbacks for other alert sources.
    targetIdentifier:
      alert.labels["name"] ??
      alert.labels["container"] ??
      alert.labels["service"] ??
      alert.labels["job"] ??
      "unknown",
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
