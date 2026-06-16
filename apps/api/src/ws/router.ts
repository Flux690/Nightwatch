import { randomUUID } from "node:crypto";
import type {
  CapabilityManifest,
  RunnerCommandMessage,
  RunnerResultMessage,
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
  send: (msg: string) => void;
  close: () => void;
  manifest: CapabilityManifest | null;
  hostname: string | null;
  lastSeen: number;
}

export interface RunnerView {
  tokenId: string;
  hostname: string | null;
  manifest: CapabilityManifest | null;
  lastSeen: number;
  online: boolean;
}

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
  registry.set(tokenId, {
    tokenId,
    send,
    close,
    manifest: null,
    hostname: null,
    lastSeen: Date.now(),
  });
}

export function unregisterRunner(tokenId: string): void {
  registry.delete(tokenId);
}

// Close every runner socket authenticated with this token. Called by the
// revoke route so revocation cuts access immediately, not just on next auth.
export function closeTokenRunners(tokenId: string): void {
  registry.get(tokenId)?.close();
}

export function setRunnerManifest(
  tokenId: string,
  manifest: CapabilityManifest,
): void {
  const conn = registry.get(tokenId);
  if (!conn) return;
  conn.manifest = manifest;
  conn.hostname = manifest.hostname;
  conn.lastSeen = Date.now();
}

export function recordHeartbeat(tokenId: string): void {
  const conn = registry.get(tokenId);
  if (!conn) return;
  conn.lastSeen = Date.now();
}

export function listRunners(): RunnerView[] {
  const now = Date.now();
  const views: RunnerView[] = [];
  for (const [tokenId, conn] of registry) {
    views.push({
      tokenId,
      hostname: conn.hostname,
      manifest: conn.manifest,
      lastSeen: conn.lastSeen,
      online: now - conn.lastSeen < HEARTBEAT_TTL_MS,
    });
  }
  return views;
}

export function getRunnerHostname(tokenId: string): string | undefined {
  return registry.get(tokenId)?.hostname ?? undefined;
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

// Route across the whole flat fleet. Single-runner deployments use the
// any-runner fallback. Multi-runner deployments route by containerName
// (manifest lookup) or hostname; ambiguous host-level commands error with
// the known set so the model can retry with a hostname parameter.
function resolveRunner(
  commandInput: Record<string, unknown>,
): RunnerConnection {
  if (registry.size === 0) throw new RunnerOfflineError();

  if (registry.size === 1) {
    // size is confirmed 1 above; the iterator value is guaranteed to be defined
    return registry.values().next().value as RunnerConnection;
  }

  const containerName =
    typeof commandInput["containerName"] === "string"
      ? commandInput["containerName"]
      : null;
  const hostname =
    typeof commandInput["hostname"] === "string"
      ? commandInput["hostname"]
      : null;

  if (containerName !== null) {
    for (const conn of registry.values()) {
      if (conn.manifest?.capabilities.containers.includes(containerName)) {
        return conn;
      }
    }
    const known = [...registry.values()]
      .flatMap((c) => c.manifest?.capabilities.containers ?? [])
      .join(", ");
    throw new Error(
      `No runner has container '${containerName}'. Known containers: ${known || "none"}`,
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
  _tokenId: string,
  commandName: string,
  commandInput: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<unknown> {
  const conn = resolveRunner(commandInput);
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
