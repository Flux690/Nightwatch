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

// A runner liveness window: a runner whose last heartbeat is older than this is
// treated as offline even if its socket has not yet emitted `close` (a half-open
// connection). Matches the TTL the Redis heartbeat key used to carry.
const HEARTBEAT_TTL_MS = 120_000;

// The connection registry is the only home for per-runner liveness and
// capability now - manifests and heartbeats live here in memory, never in Redis
// (CONTEXT.md D2). It is keyed (token, runnerId) so a second runner sharing a
// token can never overwrite the first's manifest or keep a dead one looking
// alive.
interface RunnerConnection {
  send: (msg: string) => void;
  manifest: CapabilityManifest | null;
  hostname: string | null;
  lastSeen: number;
}

// A single registry row surfaced to the /runners endpoint.
export interface RunnerView {
  token: string;
  runnerId: string;
  hostname: string | null;
  manifest: CapabilityManifest | null;
  lastSeen: number;
  online: boolean;
}

const registry = new Map<string, Map<string, RunnerConnection>>();

export class RunnerOfflineError extends Error {
  // The message becomes a tool_result fed back to the LLM and is logged, so it
  // must never carry the deployment token (a secret). It identifies no token:
  // the loop already knows which deployment it is running for.
  constructor() {
    super("No runner is connected for this deployment");
    this.name = "RunnerOfflineError";
  }
}

function getConnection(
  token: string,
  runnerId: string,
): RunnerConnection | undefined {
  return registry.get(token)?.get(runnerId);
}

export function registerRunner(
  token: string,
  runnerId: string,
  send: (msg: string) => void,
): void {
  let runners = registry.get(token);
  if (!runners) {
    runners = new Map();
    registry.set(token, runners);
  }
  // Seed lastSeen at connect so a runner is online before its first heartbeat.
  runners.set(runnerId, {
    send,
    manifest: null,
    hostname: null,
    lastSeen: Date.now(),
  });
}

export function unregisterRunner(token: string, runnerId: string): void {
  const runners = registry.get(token);
  if (!runners) return;
  runners.delete(runnerId);
  if (runners.size === 0) registry.delete(token);
}

export function setRunnerManifest(
  token: string,
  runnerId: string,
  manifest: CapabilityManifest,
): void {
  const conn = getConnection(token, runnerId);
  if (!conn) return;
  conn.manifest = manifest;
  conn.hostname = manifest.hostname;
  conn.lastSeen = Date.now();
}

export function recordHeartbeat(token: string, runnerId: string): void {
  const conn = getConnection(token, runnerId);
  if (!conn) return;
  conn.lastSeen = Date.now();
}

// Every connected runner, one row per (token, runnerId), with liveness derived
// from heartbeat freshness. The /runners endpoint reads this - the fleet view is
// per runner, not per token, so one live runner never masks a dead sibling.
export function listRunners(): RunnerView[] {
  const now = Date.now();
  const views: RunnerView[] = [];
  for (const [token, runners] of registry) {
    for (const [runnerId, conn] of runners) {
      views.push({
        token,
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

export function sendCommand(
  token: string,
  commandName: string,
  commandInput: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<unknown> {
  // Any live runner on the token (single-runner deployments and pre-routing).
  // Container-targeted routing by manifest is issue 026.
  const conn = registry.get(token)?.values().next().value;
  if (!conn) throw new RunnerOfflineError();
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
