import { serviceIdentityKey, type ServiceIdentity } from "@nightwarden/shared";
import { addressName, manifestedConnections } from "./fleet.js";
import type { RunnerConnection } from "./fleet.js";

// How a runner command is addressed: by service target key, or by server name.
// Declared per tool in the registry, never inferred from input shape.
export type CommandRoute = "service" | "host";

// The owning runner plus the advertised identity behind a target key, so the
// transport can expand the flat key back into the structured runner payload.
export interface ResolvedService {
  conn: RunnerConnection;
  identity: ServiceIdentity;
}

// Service-routed (validate-and-route): the flat target key the model echoed must
// match exactly one advertising runner, or fail loud.
export function resolveByService(
  commandInput: Record<string, unknown>,
): ResolvedService {
  const manifested = manifestedConnections();

  const target =
    typeof commandInput["target"] === "string" ? commandInput["target"] : null;
  if (target === null) {
    throw new Error(
      "This command requires a 'target' key. Copy it exactly from the FLEET SUMMARY or a list result.",
    );
  }

  const owners: ResolvedService[] = [];
  for (const conn of manifested) {
    const match = conn.manifest?.capabilities.services.find(
      (s) => serviceIdentityKey(s.identity) === target,
    );
    if (match) owners.push({ conn, identity: match.identity });
  }

  const [owner] = owners;
  if (owners.length === 1 && owner) return owner;

  if (owners.length > 1) {
    const servers = owners.map((o) => addressName(o.conn)).filter(Boolean);
    throw new Error(
      `Ambiguous target '${target}': advertised by more than one runner (${servers.join(", ")}). Add a server/cluster dimension to disambiguate.`,
    );
  }

  const known = manifested
    .flatMap((c) => c.manifest?.capabilities.services ?? [])
    .map((s) => serviceIdentityKey(s.identity))
    .join(", ");
  throw new Error(
    `No runner has target '${target}'. Known targets: ${known || "none"}`,
  );
}

// The required `server` param is the operator-assigned name shown in the fleet
// map; name or loud error, never a fallback target.
export function resolveByHost(
  commandInput: Record<string, unknown>,
): RunnerConnection {
  const manifested = manifestedConnections();

  const available = (): string =>
    manifested
      .map((c) => addressName(c))
      .filter(Boolean)
      .join(", ") || "none";

  const server =
    typeof commandInput["server"] === "string" ? commandInput["server"] : null;
  if (server === null) {
    throw new Error(
      `This command requires a 'server' parameter - the server name as shown in the fleet map. Available: ${available()}`,
    );
  }

  const matches = manifested.filter((c) => addressName(c) === server);
  const [match] = matches;
  if (matches.length === 1 && match) return match;

  if (matches.length > 1) {
    throw new Error(
      `Server name '${server}' matches more than one connected runner. Assign unique server names in the console, then retry.`,
    );
  }

  throw new Error(`No server named '${server}'. Available: ${available()}`);
}
