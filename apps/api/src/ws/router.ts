import type {
  DockerServiceIdentity,
  KubernetesWorkloadIdentity,
  Platform,
} from "@nightwarden/shared";
import { addressName, manifestedConnections } from "./fleet.js";
import type { RunnerConnection } from "./fleet.js";

// How a runner command is addressed: by service target key, or by the runner itself.
// Declared per tool in the registry, never inferred from input shape.
type RouteBy = "service" | "runner";

// A fan-out wider than this is noise, not evidence: the model cannot read ten
// hosts' filesystems in one turn and the token cost is real.
const MAX_FANOUT = 8;

// The owning runner plus the advertised identity behind a target key, so the
// transport can expand the flat key back into the structured payload. Nothing here
// narrows it: the identity only ever returns to the runner that advertised it.
interface ResolvedService {
  conn: RunnerConnection;
  identity: DockerServiceIdentity | KubernetesWorkloadIdentity;
}

// Raised when runners are connected but none runs this platform. Distinct from
// RunnerOfflineError, which means no runner at all - the two need different fixes.
export class NoPlatformRunnerError extends Error {
  constructor(platform: Platform) {
    super(
      `No connected runner runs ${platform}. This command is only available on a ${platform} runner.`,
    );
    this.name = "NoPlatformRunnerError";
  }
}

// Every runner advertising a target key, in fleet order. Each entry carries the key
// its own runner built, so this compares strings and never rebuilds one.
function ownersOf(target: string): ResolvedService[] {
  const owners: ResolvedService[] = [];
  for (const conn of manifestedConnections()) {
    const match = conn.manifest?.services.find((s) => s.target === target);
    if (match) owners.push({ conn, identity: match.identity });
  }
  return owners;
}

// Service-routed (validate-and-route): the flat target key the model echoed must match an
// advertising runner. Identity carries no scope any more, so a key advertised by two runners
// is a normal state, disambiguated by the optional `runner` parameter rather than by the key.
export function resolveByService(
  commandInput: Record<string, unknown>,
): ResolvedService {
  const target =
    typeof commandInput["target"] === "string" ? commandInput["target"] : null;
  if (target === null) {
    throw new Error(
      "This command requires a 'target' key. Copy it exactly from the FLEET SUMMARY or a list result.",
    );
  }

  const owners = ownersOf(target);
  const [only] = owners;
  // One owner: route to it whatever `runner` says. A stale runner name is not
  // worth failing a call that has exactly one possible destination.
  if (owners.length === 1 && only) return only;

  if (owners.length > 1) {
    const names = owners.map((o) => addressName(o.conn) ?? "unnamed");
    const requested = requestedRunner(commandInput);
    if (requested === null) {
      throw new Error(
        `Target '${target}' is advertised by more than one runner (${names.join(", ")}). Retry with runner set to the one you mean.`,
      );
    }
    const picked = owners.find((o) => addressName(o.conn) === requested);
    if (picked) return picked;
    throw new Error(
      `No runner named '${requested}' advertises target '${target}'. It is advertised by: ${names.join(", ")}.`,
    );
  }

  // Annotated because `services` is a union of two array types, which flatMap
  // cannot widen on its own; only the key is read here, which both arms carry.
  const known = manifestedConnections()
    .flatMap((c): Array<{ target: string }> => c.manifest?.services ?? [])
    .map((s) => s.target)
    .join(", ");
  throw new Error(
    `No runner has target '${target}'. Known targets: ${known || "none"}`,
  );
}

// Runner-routed: `runner` names one, and its absence fans out to every runner of
// this platform. A fan-out reaches only runners of that platform, so a Kubernetes
// cluster is never asked for a Docker host's filesystems.
export function resolveByRunner(
  commandInput: Record<string, unknown>,
  platform: Platform,
): RunnerConnection[] {
  const capable = manifestedConnections().filter(
    (c) => c.platform === platform,
  );
  if (capable.length === 0) throw new NoPlatformRunnerError(platform);

  const available = (): string =>
    capable
      .map((c) => addressName(c))
      .filter(Boolean)
      .join(", ") || "none";

  const requested = requestedRunner(commandInput);
  if (requested === null) return capable.slice(0, MAX_FANOUT);

  const matches = capable.filter((c) => addressName(c) === requested);
  const [match] = matches;
  if (matches.length === 1 && match) return [match];

  if (matches.length > 1) {
    throw new Error(
      `Runner name '${requested}' matches more than one connected runner. Assign unique names in the console, then retry.`,
    );
  }
  throw new Error(
    `No ${platform} runner named '${requested}'. Available: ${available()}`,
  );
}

// The address the model supplies, which the transport strips before dispatch. Never
// stored, and never part of a target key.
function requestedRunner(commandInput: Record<string, unknown>): string | null {
  const runner = commandInput["runner"];
  return typeof runner === "string" && runner !== "" ? runner : null;
}

// Whether a target key is advertised by more than one runner, so the fleet summary
// can mark it and the model learns it needs `runner` before it burns a turn.
export function isSharedTarget(target: string): boolean {
  try {
    return ownersOf(target).length > 1;
  } catch {
    // No manifested runner at all: nothing is shared.
    return false;
  }
}
