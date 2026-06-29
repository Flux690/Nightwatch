import { randomUUID } from "node:crypto";
import {
  serviceIdentityKey,
  type CapabilityManifest,
  type FleetRunner,
  type ServiceIdentity,
  type SetRemediationModeMessage,
} from "@nightwatch/shared";
import { logger } from "../logger.js";

const HEARTBEAT_TTL_MS = 120_000;

// Single map keyed by tokenId. The tokenId is the stable runner identity from
// the moment of first authentication - no manifest required.
export interface RunnerConnection {
  tokenId: string;
  send: (msg: string) => void;
  close: () => void;
  manifest: CapabilityManifest | null;
  hostname: string | null;
  lastSeen: number;
  remediationMode: boolean | null;
}

export interface RunnerView {
  tokenId: string;
  hostname: string | null;
  manifest: CapabilityManifest | null;
  lastSeen: number;
  online: boolean;
  remediationMode: boolean | null;
}

const connectionsByTokenId = new Map<string, RunnerConnection>();

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
    send,
    close,
    manifest: null,
    hostname: null,
    lastSeen: Date.now(),
    remediationMode: null,
  });
}

export function unregisterRunner(tokenId: string): void {
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
  conn.manifest = manifest;
  conn.hostname = manifest.hostname;
  conn.lastSeen = Date.now();
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

// The live read-only fleet picture (CONTEXT.md Fleet view): every runner whose manifest
// arrived, with its advertised service identities. Used by the agent, the ingest resolver,
// and the console fleet page.
export function getFleetView(): FleetRunner[] {
  const now = Date.now();
  const views: FleetRunner[] = [];
  for (const conn of connectionsByTokenId.values()) {
    if (!conn.manifest) continue;
    views.push({
      runnerId: conn.tokenId,
      hostname: conn.manifest.hostname,
      online: now - conn.lastSeen < HEARTBEAT_TTL_MS,
      lastSeen: conn.lastSeen,
      services: conn.manifest.capabilities.services,
    });
  }
  return views;
}

// Current manifest for a runner given the tokenId stamped on an alert.
export function getRunnerManifestForAlert(
  runnerId: string,
): CapabilityManifest | null {
  return connectionsByTokenId.get(runnerId)?.manifest ?? null;
}

// Sync the in-memory remediation mode for a connected runner without pushing
// to the runner (used by server.ts reconciliation for the bootstrap and
// agree-in-place cases where no push is needed).
export function setRunnerRemediationMode(tokenId: string, mode: boolean): void {
  const conn = connectionsByTokenId.get(tokenId);
  if (conn) conn.remediationMode = mode;
}

// Read the cached remediation mode by tokenId (which is now also the runnerId).
export function getRunnerRemediationMode(runnerId: string): boolean | null {
  return connectionsByTokenId.get(runnerId)?.remediationMode ?? null;
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

// Route across the flat fleet (ADR-0004 validate-and-route): a command naming a service
// identity must match exactly one runner or fail loud; one with no identity falls back to
// the legacy hint/single-runner/hostname chain (each logs a deprecation). Exported for the transport.
export function resolveRunner(
  commandInput: Record<string, unknown>,
  runnerIdHint?: string,
): RunnerConnection {
  // Only runners whose manifest has arrived are routable.
  const manifested = [...connectionsByTokenId.values()].filter(
    (c) => c.manifest !== null,
  );
  if (manifested.length === 0) throw new RunnerOfflineError();

  const service = isServiceIdentity(commandInput["service"])
    ? commandInput["service"]
    : null;

  if (service !== null) {
    const key = serviceIdentityKey(service);
    const owners = manifested.filter((conn) =>
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

    const known = manifested
      .flatMap((c) => c.manifest?.capabilities.services ?? [])
      .map((s) => serviceIdentityKey(s.identity))
      .join(", ");
    throw new Error(
      `No runner has service '${key}'. Known services: ${known || "none"}`,
    );
  }

  if (runnerIdHint) {
    const hinted = connectionsByTokenId.get(runnerIdHint);
    if (hinted && hinted.manifest !== null) {
      logger.warn(
        { runnerId: runnerIdHint },
        "resolveRunner used the deprecated runnerId hint fallback; route by service identity instead",
      );
      return hinted;
    }
  }

  if (manifested.length === 1) {
    logger.warn(
      "resolveRunner used the deprecated single-runner fallback; route by service identity instead",
    );
    // TypeScript cannot narrow array index access after a .length check.
    return manifested[0] as RunnerConnection;
  }

  const hostname =
    typeof commandInput["hostname"] === "string"
      ? commandInput["hostname"]
      : null;

  if (hostname !== null) {
    for (const conn of manifested) {
      if (conn.hostname === hostname) {
        logger.warn(
          { hostname },
          "resolveRunner used the deprecated hostname fallback; route by service identity instead",
        );
        return conn;
      }
    }
    const available = manifested
      .map((c) => c.hostname)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `No runner has hostname '${hostname}'. Available: ${available || "none"}`,
    );
  }

  const hostnames = manifested
    .map((c) => c.hostname)
    .filter(Boolean)
    .join(", ");
  throw new Error(
    `Multiple runners registered. Specify a hostname parameter: ${hostnames}`,
  );
}
