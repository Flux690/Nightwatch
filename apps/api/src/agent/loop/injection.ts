import type { NormalizedAlert } from "@nightwarden/shared";

// An injected alert names itself by its labels: the run is already under way, so
// the fleet summary it was opened with is the map the agent matches them against.
function formatLabels(labels: Record<string, string>): string {
  const rendered = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return rendered || "no labels";
}

// Stated, never asked: the alert source already grouped it, and asking the
// model would hand a routing call to the thing being routed.
export function formatInjectedAlerts(alerts: NormalizedAlert[]): string {
  const header =
    alerts.length === 1
      ? "Another alert in this same alert group has fired while you were working. It is part of the incident you are investigating. Take it into account."
      : `${alerts.length} further alerts in this same alert group have fired while you were working. They are part of the incident you are investigating. Take them into account.`;
  return (
    header +
    "\n" +
    alerts
      .map(
        (a) =>
          `- [${a.alertType}] ${formatLabels(a.labels)} (${a.labels["severity"] ?? "no severity"}) fired at ${a.firedAt} [id: ${a.sourceAlertId}]`,
      )
      .join("\n")
  );
}
