import { randomUUID } from "node:crypto";
import {
  serviceIdentityKey,
  type CapabilityManifest,
  type RunnerCommandMessage,
  type RunnerResultMessage,
  type ServiceIdentity,
} from "@nightwatch/shared";

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
}

export interface RunnerView {
  runnerId: string | null;
  tokenId: string;
  hostname: string | null;
  manifest: CapabilityManifest | null;
  lastSeen: number;
  online: boolean;
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

export function resolveCommand(payload: RunnerResultMessage["payload"]): void {
  const entry = pending.get(payload.correlationId);
  if (!entry) return;
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

// Route across the whole flat fleet. Single-runner deployments use the
// any-runner fallback. Multi-runner deployments route by durable service
// identity (manifest lookup) or hostname; ambiguous host-level commands error
// with the known set so the model can retry with a hostname parameter.
function resolveRunner(
  commandInput: Record<string, unknown>,
  runnerIdHint?: string,
): RunnerConnection {
  if (registry.size === 0) throw new RunnerOfflineError();

  if (runnerIdHint) {
    const hinted = registry.get(runnerIdHint);
    if (hinted) return hinted;
  }

  if (registry.size === 1) {
    // size is confirmed 1 above; the iterator value is guaranteed to be defined
    return registry.values().next().value as RunnerConnection;
  }

  const service = isServiceIdentity(commandInput["service"])
    ? commandInput["service"]
    : null;
  const hostname =
    typeof commandInput["hostname"] === "string"
      ? commandInput["hostname"]
      : null;

  if (service !== null) {
    const key = serviceIdentityKey(service);
    for (const conn of registry.values()) {
      if (
        conn.manifest?.capabilities.services.some(
          (s) => serviceIdentityKey(s.identity) === key,
        )
      ) {
        return conn;
      }
    }
    const known = [...registry.values()]
      .flatMap((c) => c.manifest?.capabilities.services ?? [])
      .map((s) => serviceIdentityKey(s.identity))
      .join(", ");
    throw new Error(
      `No runner has service '${key}'. Known services: ${known || "none"}`,
    );
  }

  if (hostname !== null) {
    for (const conn of registry.values()) {
      if (conn.hostname === hostname) return conn;
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
