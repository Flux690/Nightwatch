import { serviceIdentityKey, type FleetRunner, type NormalizedAlert } from "@nightwatch/shared";
import type { ParsedAlert } from "./parsers/alertmanager.js";

export type AlertResolution =
  | { kind: "resolved"; alerts: NormalizedAlert[] }
  | { kind: "rejected"; status: number; error: string };

// Matches each alert's candidate identity against the fleet's advertised
// services (ADR-0004 resolve-or-reject). The token authenticated the request;
// only the label-derived identity decides the runner. A pure function over an
// explicit fleet snapshot so the matching logic is testable without any
// WebSocket/registry state.
export function resolveAlerts(
  parsed: ParsedAlert[],
  fleet: FleetRunner[],
): AlertResolution {
  const online = fleet.filter((r) => r.online);

  // An empty fleet is a transient outage (retry once a runner connects), not
  // a label problem - distinct from "online, but nothing matches" below.
  if (online.length === 0) {
    return {
      kind: "rejected",
      status: 503,
      error: "no runner connected to route this alert",
    };
  }

  const resolved: NormalizedAlert[] = [];
  for (const alert of parsed) {
    const key = serviceIdentityKey(alert.targetIdentifier);
    const owners = online.filter((r) =>
      r.services.some((s) => serviceIdentityKey(s.identity) === key),
    );

    const [owner] = owners;
    if (owners.length === 1 && owner) {
      resolved.push({
        ...alert,
        runnerId: owner.runnerId,
        hostname: owner.hostname,
      });
      continue;
    }

    if (owners.length > 1) {
      const hostnames = owners.map((r) => r.hostname).join(", ");
      return {
        kind: "rejected",
        status: 400,
        error: `Ambiguous service '${key}': advertised by more than one runner (${hostnames}). Add a server/cluster dimension to disambiguate.`,
      };
    }

    const known = online
      .flatMap((r) => r.services.map((s) => serviceIdentityKey(s.identity)))
      .join(", ");
    return {
      kind: "rejected",
      status: 400,
      error: `No runner advertises service '${key}'. Known services: ${known || "none"}.`,
    };
  }

  return { kind: "resolved", alerts: resolved };
}
