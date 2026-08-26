import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  FleetRunner,
  HideContainerMessage,
  Platform,
  RunnerIdentityMessage,
  RunnerManifest,
} from "@nightwarden/shared";

const LIVENESS_TTL_MS = 120_000;

// Single map keyed by runnerId — the stable DB primary key assigned at onboarding.
export interface RunnerConnection {
  runnerId: string;
  // Read from the runner's row at authentication, so it is known before any
  // manifest arrives and cannot be contradicted by what the runner reports.
  platform: Platform;
  // User-assigned server name (unique by DB constraint) - the model-visible
  // address, and the first segment of every target key this runner advertises.
  serverName: string;
  send: (msg: string) => void;
  close: () => void;
  manifest: RunnerManifest | null;
  hostname: string | null;
  lastSeen: number;
}

interface RunnerView {
  runnerId: string;
  platform: Platform;
  serverName: string;
  hostname: string | null;
  manifest: RunnerManifest | null;
  lastSeen: number;
  online: boolean;
}

const connectionsByRunnerId = new Map<string, RunnerConnection>();

export class RunnerOfflineError extends Error {
  constructor() {
    super("No server is connected for this deployment");
    this.name = "RunnerOfflineError";
  }
}

interface RunnerRegistration {
  runnerId: string;
  platform: Platform;
  send: (msg: string) => void;
  close: () => void;
  serverName: string;
}

export function registerRunner({
  runnerId,
  platform,
  send,
  close,
  serverName,
}: RunnerRegistration): RunnerConnection {
  // A reconnect can beat the old socket's close event; displace the stale
  // socket loudly instead of trusting close ordering.
  connectionsByRunnerId.get(runnerId)?.close();
  const conn: RunnerConnection = {
    runnerId,
    platform,
    serverName,
    send,
    close,
    manifest: null,
    hostname: null,
    lastSeen: Date.now(),
  };
  connectionsByRunnerId.set(runnerId, conn);
  pushIdentity(conn);
  pushHiddenContainer(conn);
  return conn;
}

// A displaced socket's late close event must not delete the replacement
// connection registered under the same runnerId.
export function unregisterRunner(conn: RunnerConnection): boolean {
  if (connectionsByRunnerId.get(conn.runnerId) !== conn) return false;
  connectionsByRunnerId.delete(conn.runnerId);
  return true;
}

// Close every runner socket authenticated with this runner id. Called by the
// revoke route so revocation cuts access immediately, not just on next auth.
export function closeRunnerConnections(runnerId: string): void {
  connectionsByRunnerId.get(runnerId)?.close();
}

export function setRunnerManifest(
  runnerId: string,
  manifest: RunnerManifest,
): void {
  const conn = connectionsByRunnerId.get(runnerId);
  if (!conn) return;
  conn.manifest = manifest;
  conn.hostname = manifest.hostname;
  conn.lastSeen = Date.now();
}

// Takes the connection, not the runnerId: a displaced socket's late pong then
// touches the dead object instead of the replacement's registry entry.
export function markRunnerAlive(conn: RunnerConnection): void {
  conn.lastSeen = Date.now();
}

export function listRunners(): RunnerView[] {
  const now = Date.now();
  const views: RunnerView[] = [];
  for (const conn of connectionsByRunnerId.values()) {
    views.push({
      runnerId: conn.runnerId,
      platform: conn.platform,
      serverName: conn.serverName,
      hostname: conn.hostname,
      manifest: conn.manifest,
      lastSeen: conn.lastSeen,
      online: now - conn.lastSeen < LIVENESS_TTL_MS,
    });
  }
  return views;
}

// Every runner whose manifest arrived, with its advertised service identities.
export function getFleetView(): FleetRunner[] {
  const now = Date.now();
  const views: FleetRunner[] = [];
  for (const conn of connectionsByRunnerId.values()) {
    const manifest = conn.manifest;
    if (!manifest) continue;
    const base = {
      runnerId: conn.runnerId,
      serverName: conn.serverName,
      hostname: manifest.hostname,
      online: now - conn.lastSeen < LIVENESS_TTL_MS,
      lastSeen: conn.lastSeen,
    };
    // Projecting one discriminated union onto another: the arms differ only in
    // which entry type `services` holds, which is exactly what callers narrow on.
    views.push(
      manifest.platform === "docker"
        ? { ...base, platform: "docker", services: manifest.services }
        : { ...base, platform: "kubernetes", services: manifest.services },
    );
  }
  return views;
}

// Sent before anything else: the runner cannot build a target key until it knows
// the name those keys are prefixed with, so it holds its manifest back until this.
function pushIdentity(conn: RunnerConnection): void {
  const msg: RunnerIdentityMessage = {
    messageId: randomUUID(),
    type: "identity",
    payload: { serverName: conn.serverName },
  };
  conn.send(JSON.stringify(msg));
}

// Anchored on the containers path, because mountinfo also lists overlay layer
// directories whose names are 64-hex and are not ids.
function ownContainerId(): string | null {
  const sources: Array<[string, RegExp]> = [
    ["/proc/self/mountinfo", /\/docker\/containers\/([0-9a-f]{64})/],
    ["/proc/self/cgroup", /\b([0-9a-f]{64})\b/],
  ];
  for (const [file, pattern] of sources) {
    try {
      const match = pattern.exec(readFileSync(file, "utf8"));
      if (match?.[1]) return match[1];
    } catch {
      // Not containerized, or the host does not expose it: nothing to identify.
    }
  }
  return null;
}

const apiContainerId = ownContainerId();

// The runner already excludes itself; this covers the API beside it. Docker
// only, because a cluster runner lists workloads and the API is not one.
function pushHiddenContainer(conn: RunnerConnection): void {
  if (!apiContainerId || conn.platform !== "docker") return;
  const msg: HideContainerMessage = {
    messageId: randomUUID(),
    type: "hide_container",
    payload: { containerId: apiContainerId },
  };
  conn.send(JSON.stringify(msg));
}

// Only runners whose manifest has arrived are routable.
export function manifestedConnections(): RunnerConnection[] {
  const manifested = [...connectionsByRunnerId.values()].filter(
    (c) => c.manifest !== null,
  );
  if (manifested.length === 0) throw new RunnerOfflineError();
  return manifested;
}
