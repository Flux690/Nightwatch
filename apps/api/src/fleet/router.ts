import type {
  DockerServiceIdentity,
  KubernetesWorkloadIdentity,
  Platform,
} from "@nightwarden/shared";
import { manifestedConnections } from "../fleet/connections.js";
import type { RunnerConnection } from "../fleet/connections.js";

// A fan-out wider than this is noise, not evidence: the model cannot read ten
// servers' filesystems in one turn and the token cost is real.
const MAX_FANOUT = 8;

// Lets the transport expand a flat key back into its structured payload. The
// identity only ever returns to the server that advertised it.
interface ResolvedService {
  conn: RunnerConnection;
  identity: DockerServiceIdentity | KubernetesWorkloadIdentity;
}

// Raised when servers are connected but none runs this platform. Distinct from
// RunnerOfflineError, which means no server at all - the two need different fixes.
export class NoPlatformRunnerError extends Error {
  constructor(platform: Platform) {
    super(
      `No connected server runs ${platform}. This command is only available on a ${platform} server.`,
    );
    this.name = "NoPlatformRunnerError";
  }
}

// The key names its own server, so at most one connection can advertise it and
// there is nothing to disambiguate. This compares strings and never rebuilds one.
export function resolveByService(
  commandInput: Record<string, unknown>,
): ResolvedService {
  const target =
    typeof commandInput["target"] === "string" ? commandInput["target"] : null;
  if (target === null) {
    throw new Error(
      "This command requires a 'target' key. Copy it exactly from the <fleet-summary> block or a list result.",
    );
  }

  const conns = manifestedConnections();
  for (const conn of conns) {
    const match = conn.manifest?.services.find((s) => s.target === target);
    if (match) return { conn, identity: match.identity };
  }

  // Annotated because `services` is a union of two array types, which flatMap
  // cannot widen on its own; only the key is read here, which both arms carry.
  const known = conns
    .flatMap((c): Array<{ target: string }> => c.manifest?.services ?? [])
    .map((s) => s.target)
    .join(", ");
  throw new Error(
    `No server advertises target '${target}'. Known targets: ${known || "none"}`,
  );
}

// A fan-out reaches only servers of that platform, so a Kubernetes cluster is
// never asked for a Docker host's filesystems.
export function resolveByRunner(
  commandInput: Record<string, unknown>,
  platform: Platform,
): { conns: RunnerConnection[]; omitted: number } {
  const capable = manifestedConnections().filter(
    (c) => c.platform === platform,
  );
  if (capable.length === 0) throw new NoPlatformRunnerError(platform);

  const requested = requestedServer(commandInput);
  if (requested === null) {
    return {
      conns: capable.slice(0, MAX_FANOUT),
      omitted: Math.max(0, capable.length - MAX_FANOUT),
    };
  }

  const match = capable.find((c) => c.serverName === requested);
  if (match) return { conns: [match], omitted: 0 };

  const available = capable.map((c) => c.serverName).join(", ");
  throw new Error(
    `No ${platform} server named '${requested}'. Available: ${available}`,
  );
}

// The address the model supplies for a fan-out tool, which the transport strips
// before dispatch. Never stored, and never part of a target key.
function requestedServer(commandInput: Record<string, unknown>): string | null {
  const server = commandInput["server"];
  return typeof server === "string" && server !== "" ? server : null;
}
