import { serviceIdentityKey, type ServiceIdentity } from "@nightwatch/shared";
import { addressName, manifestedConnections } from "./fleet.js";
import type { RunnerConnection } from "./fleet.js";

// A tool call's `service` field arrives as unknown JSON (from the LLM, or
// replayed from a persisted approval); narrow it before trusting its shape.
function isServiceIdentity(value: unknown): value is ServiceIdentity {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["provider"] === "docker") {
    return typeof v["project"] === "string" && typeof v["service"] === "string";
  }
  if (v["provider"] === "kubernetes") {
    return (
      typeof v["namespace"] === "string" && typeof v["workload"] === "string"
    );
  }
  return false;
}

// How a runner command is addressed: by the service identity in its input, or
// by server (the required `server` param naming the target machine). Declared
// per tool in the registry, never inferred from input shape.
export type CommandRoute = "service" | "host";

// Service-routed (validate-and-route): the identity the model echoed
// must match exactly one advertising runner, or fail loud.
export function resolveByService(
  commandInput: Record<string, unknown>,
): RunnerConnection {
  const manifested = manifestedConnections();

  const service = isServiceIdentity(commandInput["service"])
    ? commandInput["service"]
    : null;
  if (service === null) {
    throw new Error(
      "This command requires a 'service' identity. Echo it exactly as given in the alert or a prior list_services result.",
    );
  }

  const key = serviceIdentityKey(service);
  const owners = manifested.filter((conn) =>
    conn.manifest?.capabilities.services.some(
      (s) => serviceIdentityKey(s.identity) === key,
    ),
  );

  const [owner] = owners;
  if (owners.length === 1 && owner) return owner;

  if (owners.length > 1) {
    const servers = owners.map((c) => addressName(c)).filter(Boolean);
    throw new Error(
      `Ambiguous service '${key}': advertised by more than one runner (${servers.join(", ")}). Add a server/cluster dimension to disambiguate.`,
    );
  }

  const known = manifested
    .flatMap((c) => c.manifest?.capabilities.services ?? [])
    .map((s) => serviceIdentityKey(s.identity))
    .join(", ");
  throw new Error(
    `No runner has service '${key}'. Known services: ${known || "none"}`,
  );
}

// Host-routed: the required `server` param is the operator-assigned server
// name shown in the fleet map. Name or loud error - no fallback target, so a
// command can never land on a machine the model did not name.
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
