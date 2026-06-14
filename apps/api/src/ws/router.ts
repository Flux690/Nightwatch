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

// Registry is keyed by (tokenId, runnerId) — tokenId is the UUID from the
// tokens table, never the plaintext credential. This lets closeTokenRunners
// close every runner for a token without touching the plaintext.
interface RunnerConnection {
  send: (msg: string) => void;
  close: () => void;
  manifest: CapabilityManifest | null;
  hostname: string | null;
  lastSeen: number;
}

export interface RunnerView {
  tokenId: string;
  runnerId: string;
  hostname: string | null;
  manifest: CapabilityManifest | null;
  lastSeen: number;
  online: boolean;
}

const registry = new Map<string, Map<string, RunnerConnection>>();

export class RunnerOfflineError extends Error {
  constructor() {
    super("No runner is connected for this deployment");
    this.name = "RunnerOfflineError";
  }
}

function getConnection(
  tokenId: string,
  runnerId: string,
): RunnerConnection | undefined {
  return registry.get(tokenId)?.get(runnerId);
}

export function registerRunner(
  tokenId: string,
  runnerId: string,
  send: (msg: string) => void,
  close: () => void,
): void {
  let runners = registry.get(tokenId);
  if (!runners) {
    runners = new Map();
    registry.set(tokenId, runners);
  }
  runners.set(runnerId, {
    send,
    close,
    manifest: null,
    hostname: null,
    lastSeen: Date.now(),
  });
}

export function unregisterRunner(tokenId: string, runnerId: string): void {
  const runners = registry.get(tokenId);
  if (!runners) return;
  runners.delete(runnerId);
  if (runners.size === 0) registry.delete(tokenId);
}

// Close every runner socket authenticated with this token. Called by the
// revoke route so revocation cuts access immediately, not just on next auth.
export function closeTokenRunners(tokenId: string): void {
  const runners = registry.get(tokenId);
  if (!runners) return;
  for (const conn of runners.values()) {
    conn.close();
  }
}

export function setRunnerManifest(
  tokenId: string,
  runnerId: string,
  manifest: CapabilityManifest,
): void {
  const conn = getConnection(tokenId, runnerId);
  if (!conn) return;
  conn.manifest = manifest;
  conn.hostname = manifest.hostname;
  conn.lastSeen = Date.now();
}

export function recordHeartbeat(tokenId: string, runnerId: string): void {
  const conn = getConnection(tokenId, runnerId);
  if (!conn) return;
  conn.lastSeen = Date.now();
}

export function listRunners(): RunnerView[] {
  const now = Date.now();
  const views: RunnerView[] = [];
  for (const [tokenId, runners] of registry) {
    for (const [runnerId, conn] of runners) {
      views.push({
        tokenId,
        runnerId,
        hostname: conn.hostname,
        manifest: conn.manifest,
        lastSeen: conn.lastSeen,
        online: now - conn.lastSeen < HEARTBEAT_TTL_MS,
      });
    }
  }
  return views;
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

// Resolve which runner connection to use for a command. Single-runner
// deployments always use the only registered runner (any-runner fallback per
// CONTEXT.md). Multi-runner deployments route by containerName (manifest
// lookup) or hostname; missing hint on multiple runners is an error.
function resolveRunner(
  tokenId: string,
  commandInput: Record<string, unknown>,
): RunnerConnection {
  const runners = registry.get(tokenId);
  if (!runners || runners.size === 0) throw new RunnerOfflineError();

  if (runners.size === 1) {
    return runners.values().next().value as RunnerConnection;
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
    for (const conn of runners.values()) {
      if (conn.manifest?.capabilities.containers.includes(containerName)) {
        return conn;
      }
    }
    const known = [...runners.values()]
      .flatMap((c) => c.manifest?.capabilities.containers ?? [])
      .join(", ");
    throw new Error(
      `No runner has container '${containerName}'. Known containers: ${known || "none"}`,
    );
  }

  if (hostname !== null) {
    for (const conn of runners.values()) {
      if (conn.hostname === hostname) return conn;
    }
    const available = [...runners.values()]
      .map((c) => c.hostname)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `No runner has hostname '${hostname}'. Available: ${available || "none"}`,
    );
  }

  const hostnames = [...runners.values()]
    .map((c) => c.hostname)
    .filter(Boolean)
    .join(", ");
  throw new Error(
    `Multiple runners registered. Specify a hostname parameter: ${hostnames}`,
  );
}

export function sendCommand(
  tokenId: string,
  commandName: string,
  commandInput: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<unknown> {
  const conn = resolveRunner(tokenId, commandInput);
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
