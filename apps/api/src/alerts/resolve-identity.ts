import {
  serviceIdentityKey,
  type FleetRunner,
  type NormalizedAlert,
} from "@nightwatch/shared";
import type { ParsedAlert } from "./parsers/alertmanager.js";

export type AlertVerdict =
  | { kind: "resolved"; alert: NormalizedAlert }
  | { kind: "rejected"; sourceAlertId: string; reason: string };

export type AlertResolution =
  | { kind: "no-runners" }
  | { kind: "verdicts"; verdicts: AlertVerdict[] };

// Matches each alert's candidate identity against the fleet's advertised
// services (ADR-0004 resolve-or-reject). Each alert is resolved independently:
// a matched alert resolves, an unmatched or ambiguous one is rejected on its
// own without suppressing its neighbours. 503 is returned only when no runner
// is connected at all (a transient fleet outage), not per-alert.
export function resolveAlerts(
  parsed: ParsedAlert[],
  fleet: FleetRunner[],
): AlertResolution {
  const online = fleet.filter((r) => r.online);

  if (online.length === 0) {
    return { kind: "no-runners" };
  }

  const knownServices =
    online
      .flatMap((r) => r.services.map((s) => serviceIdentityKey(s.identity)))
      .join(", ") || "none";

  const verdicts: AlertVerdict[] = [];
  for (const alert of parsed) {
    const key = serviceIdentityKey(alert.targetIdentifier);
    const owners = online.filter((r) =>
      r.services.some((s) => serviceIdentityKey(s.identity) === key),
    );

    const [owner] = owners;
    if (owners.length === 1 && owner) {
      verdicts.push({
        kind: "resolved",
        alert: {
          ...alert,
          runnerId: owner.runnerId,
          hostname: owner.hostname,
        },
      });
    } else if (owners.length > 1) {
      const hostnames = owners.map((r) => r.hostname).join(", ");
      verdicts.push({
        kind: "rejected",
        sourceAlertId: alert.sourceAlertId,
        reason: `Ambiguous service '${key}': advertised by more than one runner (${hostnames}). Add a server/cluster dimension to disambiguate.`,
      });
    } else {
      verdicts.push({
        kind: "rejected",
        sourceAlertId: alert.sourceAlertId,
        reason: `No runner advertises service '${key}'. Known services: ${knownServices}.`,
      });
    }
  }

  return { kind: "verdicts", verdicts };
}
