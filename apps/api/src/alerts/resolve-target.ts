import {
  serviceIdentityKey,
  type FleetRunner,
  type NormalizedAlert,
  type ServiceIdentity,
} from "@nightwarden/shared";

// The alert's candidate target key, for display (session titles, PR body).
// "unidentified" when the labels named no service.
export function displayIdentity(alert: NormalizedAlert): string {
  return alert.targetIdentifier
    ? serviceIdentityKey(alert.targetIdentifier)
    : "unidentified";
}

// The outcome of matching an alert's candidate identity against the live fleet.
// resolved routes and names; ambiguous/unresolved hand the agent the raw labels.
export type AlertResolution =
  | { kind: "resolved"; identity: ServiceIdentity; key: string }
  | { kind: "ambiguous"; key: string; servers: string[] }
  | { kind: "unresolved"; key: string | null };

// The key with the server/cluster scope segment dropped, for the scope-tolerant match.
function unscopedKey(id: ServiceIdentity): string {
  return id.provider === "docker"
    ? `docker/${id.project}/${id.service}`
    : `kubernetes/${id.namespace}/${id.workload}`;
}

function hasScope(id: ServiceIdentity): boolean {
  return id.provider === "docker"
    ? id.server !== undefined
    : id.cluster !== undefined;
}

interface FleetService {
  identity: ServiceIdentity;
  server: string | null;
}

function fleetServices(fleet: FleetRunner[]): FleetService[] {
  return fleet.flatMap((r) =>
    r.services.map((s) => ({
      identity: s.identity,
      server: r.serverName ?? r.hostname,
    })),
  );
}

// Exact key first; then, when the candidate carries no server/cluster scope, match on
// the unscoped key - a unique hit resolves (scope was optional), several is ambiguous
// (this is where nw_server is needed). No match, or no candidate, is unresolved.
export function resolveAgainstFleet(
  candidate: ServiceIdentity | null,
  fleet: FleetRunner[],
): AlertResolution {
  if (candidate === null) return { kind: "unresolved", key: null };
  const candKey = serviceIdentityKey(candidate);
  const services = fleetServices(fleet);

  const exact = services.filter(
    (s) => serviceIdentityKey(s.identity) === candKey,
  );
  if (exact.length === 1) {
    return { kind: "resolved", identity: exact[0]!.identity, key: candKey };
  }

  if (!hasScope(candidate)) {
    const matches = services.filter((s) => unscopedKey(s.identity) === candKey);
    if (matches.length === 1) {
      const m = matches[0]!;
      return {
        kind: "resolved",
        identity: m.identity,
        key: serviceIdentityKey(m.identity),
      };
    }
    if (matches.length > 1) {
      const servers = [
        ...new Set(
          matches.map((m) => m.server).filter((s): s is string => s !== null),
        ),
      ];
      return { kind: "ambiguous", key: candKey, servers };
    }
  }

  return { kind: "unresolved", key: candKey };
}
