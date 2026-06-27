import { randomUUID } from "node:crypto";
import {
  serviceIdentityKey,
  type CapabilityManifest,
  type FleetRunner,
  type RunnerCommandMessage,
  type RunnerResultMessage,
  type ServiceIdentity,
  type SetRemediationModeMessage,
} from "@nightwatch/shared";
import { logger } from "../logger.js";

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingCommand>();

const HEARTBEAT_TTL_MS = 120_000;

// Flat registry keyed by tokenId. One token = one server in this deployment
// model; the token authenticates the connection and is the stable per-server key.
interface RunnerConnection {
  tokenId: string;
  runnerId: string | null;
  send: (msg: string) => void;
  close: () => void;
  manifest: CapabilityManifest | null;
  hostname: string | null;
  lastSeen: number;
  remediationMode: boolean | null;
}

export interface RunnerView {
  runnerId: string | null;
  tokenId: string;
  hostname: string | null;
  manifest: CapabilityManifest | null;
  lastSeen: number;
  online: boolean;
  remediationMode: boolean | null;
}

const connectionsByTokenId = new Map<string, RunnerConnection>();
const registry = new Map<string, RunnerConnection>();

export class RunnerOfflineError extends Error {
  constructor() {
    super("No runner is connected for this deployment");
    this.name = "RunnerOfflineError";
  }
}

export function registerRunner(
  tokenId: string,
  send: (msg: string) => void,
  close: () => void,
): void {
  connectionsByTokenId.set(tokenId, {
    tokenId,
    runnerId: null,
    send,
    close,
    manifest: null,
    hostname: null,
    lastSeen: Date.now(),
    remediationMode: null,
  });
}

export function unregisterRunner(tokenId: string): void {
  const conn = connectionsByTokenId.get(tokenId);
  if (conn?.runnerId) registry.delete(conn.runnerId);
  connectionsByTokenId.delete(tokenId);
}

// Close every runner socket authenticated with this token. Called by the
// revoke route so revocation cuts access immediately, not just on next auth.
export function closeTokenRunners(tokenId: string): void {
  connectionsByTokenId.get(tokenId)?.close();
}

export function setRunnerManifest(
  tokenId: string,
  manifest: CapabilityManifest,
): void {
  const conn = connectionsByTokenId.get(tokenId);
  if (!conn) return;
  if (conn.runnerId && conn.runnerId !== manifest.runnerId) {
    registry.delete(conn.runnerId);
  }
  conn.runnerId = manifest.runnerId;
  conn.manifest = manifest;
  conn.hostname = manifest.hostname;
  conn.lastSeen = Date.now();
  registry.set(manifest.runnerId, conn);
}

export function recordHeartbeat(tokenId: string): void {
  const conn = connectionsByTokenId.get(tokenId);
  if (!conn) return;
  conn.lastSeen = Date.now();
}

export function listRunners(): RunnerView[] {
  const now = Date.now();
  const views: RunnerView[] = [];
  for (const conn of connectionsByTokenId.values()) {
    views.push({
      runnerId: conn.runnerId,
      tokenId: conn.tokenId,
      hostname: conn.hostname,
      manifest: conn.manifest,
      lastSeen: conn.lastSeen,
      online: now - conn.lastSeen < HEARTBEAT_TTL_MS,
      remediationMode: conn.remediationMode,
    });
  }
  return views;
}

// The live, read-only picture of the fleet (CONTEXT.md "Fleet view"): every
// runner whose manifest has arrived, with the server-scoped service identities
// it advertises. Used by the agent for cross-server reasoning, by the ingest
// handler for resolve-or-reject matching, and by the console fleet page.
export function getFleetView(): FleetRunner[] {
  const now = Date.now();
  const views: FleetRunner[] = [];
  for (const conn of registry.values()) {
    if (!conn.manifest) continue;
    views.push({
      runnerId: conn.manifest.runnerId,
      hostname: conn.manifest.hostname,
      online: now - conn.lastSeen < HEARTBEAT_TTL_MS,
      lastSeen: conn.lastSeen,
      services: conn.manifest.capabilities.services,
    });
  }
  return views;
}

export function getRunnerIdentity(
  tokenId: string,
): { runnerId: string; hostname: string | null } | undefined {
  const conn = connectionsByTokenId.get(tokenId);
  if (!conn?.runnerId) return undefined;
  return { runnerId: conn.runnerId, hostname: conn.hostname };
}

// Returns the current manifest for a runner given the runnerId stamped on an
// alert. The runnerId is the manifest's runnerId when the manifest has been
// received; it falls back to the tokenId at ingest if the manifest hadn't
// arrived yet, so we try both maps.
export function getRunnerManifestForAlert(
  runnerId: string,
): CapabilityManifest | null {
  return (
    registry.get(runnerId)?.manifest ??
    connectionsByTokenId.get(runnerId)?.manifest ??
    null
  );
}

// Sync the in-memory remediation mode for a connected runner without pushing
// to the runner (used by server.ts reconciliation for the bootstrap and
// agree-in-place cases where no push is needed).
export function setRunnerRemediationMode(tokenId: string, mode: boolean): void {
  const conn = connectionsByTokenId.get(tokenId);
  if (conn) conn.remediationMode = mode;
}

// Read the cached remediation mode by runnerId. Tries the post-manifest
// registry first, then the pre-manifest connectionsByTokenId map (covers the
// case where an alert's runnerId was stamped as the tokenId at ingest).
export function getRunnerRemediationMode(runnerId: string): boolean | null {
  return (
    registry.get(runnerId)?.remediationMode ??
    connectionsByTokenId.get(runnerId)?.remediationMode ??
    null
  );
}

// Fire-and-forget push of remediation mode to a connected runner. Also
// updates the in-memory cache so the next reconciliation sees the new value
// and doesn't push again unnecessarily.
export function pushRemediationMode(tokenId: string, enabled: boolean): void {
  const conn = connectionsByTokenId.get(tokenId);
  if (!conn) return;
  conn.remediationMode = enabled;
  const msg: SetRemediationModeMessage = {
    messageId: randomUUID(),
    type: "set_remediation_mode",
    payload: { enabled },
  };
  conn.send(JSON.stringify(msg));
}

export function resolveCommand(payload: RunnerResultMessage["payload"]): void {
  const entry = pending.get(payload.correlationId);
  if (!entry) {
    // The command already timed out (and rejected its caller) or never existed,
    // so a late result has nowhere to go. Log it instead of dropping silently,
    // so a consistently-slow runner is diagnosable.
    logger.warn(
      { correlationId: payload.correlationId },
      "late or unknown runner result discarded",
    );
    return;
  }
  clearTimeout(entry.timer);
  pending.delete(payload.correlationId);
  if (payload.success) {
    entry.resolve(payload.result);
  } else {
    entry.reject(new Error(payload.error ?? "Runner command failed"));
  }
}

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

// Route across the whole flat fleet. A command naming a service identity is
// validated strictly against the fleet view: it must match exactly one
// runner's manifest, or the command fails loud (ADR-0004 validate-and-route).
// A command with no service identity falls back to the legacy chain (hint,
// single-runner, hostname) for backward compat; each fallback step logs a
// deprecation warning since it bypasses identity validation entirely.
function resolveRunner(
  commandInput: Record<string, unknown>,
  runnerIdHint?: string,
): RunnerConnection {
  if (registry.size === 0) throw new RunnerOfflineError();

  const service = isServiceIdentity(commandInput["service"])
    ? commandInput["service"]
    : null;

  if (service !== null) {
    const key = serviceIdentityKey(service);
    const owners = [...registry.values()].filter((conn) =>
      conn.manifest?.capabilities.services.some(
        (s) => serviceIdentityKey(s.identity) === key,
      ),
    );

    const [owner] = owners;
    if (owners.length === 1 && owner) return owner;

    if (owners.length > 1) {
      const hostnames = owners.map((c) => c.hostname).filter(Boolean);
      throw new Error(
        `Ambiguous service '${key}': advertised by more than one runner (${hostnames.join(", ")}). Add a server/cluster dimension to disambiguate.`,
      );
    }

    const known = [...registry.values()]
      .flatMap((c) => c.manifest?.capabilities.services ?? [])
      .map((s) => serviceIdentityKey(s.identity))
      .join(", ");
    throw new Error(
      `No runner has service '${key}'. Known services: ${known || "none"}`,
    );
  }

  if (runnerIdHint) {
    const hinted = registry.get(runnerIdHint);
    if (hinted) {
      logger.warn(
        { runnerId: runnerIdHint },
        "resolveRunner used the deprecated runnerId hint fallback; route by service identity instead",
      );
      return hinted;
    }
  }

  if (registry.size === 1) {
    logger.warn(
      "resolveRunner used the deprecated single-runner fallback; route by service identity instead",
    );
    // size is confirmed 1 above; the iterator value is guaranteed to be defined
    return registry.values().next().value as RunnerConnection;
  }

  const hostname =
    typeof commandInput["hostname"] === "string"
      ? commandInput["hostname"]
      : null;

  if (hostname !== null) {
    for (const conn of registry.values()) {
      if (conn.hostname === hostname) {
        logger.warn(
          { hostname },
          "resolveRunner used the deprecated hostname fallback; route by service identity instead",
        );
        return conn;
      }
    }
    const available = [...registry.values()]
      .map((c) => c.hostname)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `No runner has hostname '${hostname}'. Available: ${available || "none"}`,
    );
  }

  const hostnames = [...registry.values()]
    .map((c) => c.hostname)
    .filter(Boolean)
    .join(", ");
  throw new Error(
    `Multiple runners registered. Specify a hostname parameter: ${hostnames}`,
  );
}

export function sendCommand(
  commandName: string,
  commandInput: Record<string, unknown>,
  timeoutMs = 15_000,
  runnerIdHint?: string,
): Promise<unknown> {
  const conn = resolveRunner(commandInput, runnerIdHint);
  const { send } = conn;

  const correlationId = randomUUID();
  const msg: RunnerCommandMessage = {
    messageId: randomUUID(),
    type: "command",
    payload: { commandName, commandInput, correlationId },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      reject(
        new Error(`Command ${commandName} timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    pending.set(correlationId, { resolve, reject, timer });
    send(JSON.stringify(msg));
  });
}
