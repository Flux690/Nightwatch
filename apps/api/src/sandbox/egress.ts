import { createHash } from "node:crypto";
import { demuxOutput, getDocker, SANDBOX_IMAGE } from "./docker.js";
import { EGRESS_PROXY_SCRIPT } from "./egress-proxy-script.js";

// The sandbox network is Internal: containers on it have no route to the
// internet, so the dual-homed proxy is their only way out - real enforcement,
// not proxy-env-var etiquette.
export const EGRESS_NETWORK = "nightwatch-sandbox-net";
export const EGRESS_PROXY_NAME = "nightwatch-sandbox-proxy";
export const EGRESS_PROXY_PORT = 8080;
export const EGRESS_PROXY_URL = `http://${EGRESS_PROXY_NAME}:${EGRESS_PROXY_PORT}`;

const NETWORK_LABEL = "nightwatch.sandbox.net";
const PROXY_LABEL = "nightwatch.sandbox.proxy";
const HASH_LABEL = "nightwatch.egress.hash";

function allowlistHash(allowlist: readonly string[]): string {
  return createHash("sha256")
    .update([...allowlist].sort().join(","))
    .digest("hex")
    .slice(0, 16);
}

let networkPromise: Promise<void> | null = null;

// Idempotent: create the Internal network once, reuse forever. Single-flight so
// concurrent first sessions don't race two creates.
export function ensureEgressNetwork(): Promise<void> {
  if (networkPromise) return networkPromise;
  networkPromise = (async () => {
    const docker = getDocker();
    const existing = await docker.listNetworks({
      filters: JSON.stringify({ name: [EGRESS_NETWORK] }),
    });
    if (existing.some((n) => n.Name === EGRESS_NETWORK)) return;
    try {
      await docker.createNetwork({
        Name: EGRESS_NETWORK,
        Internal: true,
        Labels: { [NETWORK_LABEL]: "1" },
      });
    } catch (err) {
      // A concurrent process (or a prior boot) may have created it first.
      if (!/already exists/i.test(String(err))) throw err;
    }
  })().catch((err: unknown) => {
    networkPromise = null;
    throw err;
  });
  return networkPromise;
}

interface ProxyContainerRef {
  Id: string;
  Labels: Record<string, string>;
  State: string;
}

async function findProxy(): Promise<ProxyContainerRef | null> {
  const list = await getDocker().listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${PROXY_LABEL}=1`] }),
  });
  const first = list[0];
  if (!first) return null;
  return {
    Id: first.Id,
    Labels: first.Labels ?? {},
    State: first.State ?? "",
  };
}

let proxyPromise: Promise<void> | null = null;

// Ensures one shared proxy container is running for the given allowlist. If the
// allowlist changed since the live proxy started (hash label mismatch) the old
// one is replaced, so an operator's edit takes effect on the next sandbox.
export function ensureProxy(allowlist: readonly string[]): Promise<void> {
  const hash = allowlistHash(allowlist);
  // Coalesce concurrent callers; re-check the hash inside so a stale in-flight
  // ensure for a different allowlist still triggers a recreate afterwards.
  if (proxyPromise) {
    return proxyPromise.then(() => reconcileProxy(allowlist, hash));
  }
  proxyPromise = reconcileProxy(allowlist, hash).finally(() => {
    proxyPromise = null;
  });
  return proxyPromise;
}

async function reconcileProxy(
  allowlist: readonly string[],
  hash: string,
): Promise<void> {
  await ensureEgressNetwork();
  const docker = getDocker();
  const existing = await findProxy();
  if (existing) {
    if (existing.Labels[HASH_LABEL] === hash && existing.State === "running") {
      return;
    }
    await docker
      .getContainer(existing.Id)
      .remove({ force: true })
      .catch(() => undefined);
  }

  const container = await docker.createContainer({
    Image: SANDBOX_IMAGE,
    name: EGRESS_PROXY_NAME,
    Cmd: ["node", "-e", EGRESS_PROXY_SCRIPT],
    Env: [`PORT=${EGRESS_PROXY_PORT}`, `ALLOW=${allowlist.join(",")}`],
    Labels: { [PROXY_LABEL]: "1", [HASH_LABEL]: hash },
    HostConfig: {
      // Default bridge stays attached for outbound; the internal network is
      // added below so sandboxes can reach the proxy by name.
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: 256,
    },
  });
  await container.start();
  await docker
    .getNetwork(EGRESS_NETWORK)
    .connect({ Container: container.id })
    .catch((err: unknown) => {
      // If we can't dual-home it, it's useless - tear it down so a retry is clean.
      void docker
        .getContainer(container.id)
        .remove({ force: true })
        .catch(() => undefined);
      throw err;
    });
}

// The network/proxy single-flight promises are process state; tests that vary
// the fake daemon reset them, the same support resetIsolationCache provides.
export function resetEgressState(): void {
  networkPromise = null;
  proxyPromise = null;
}

// Boot-time and disconnect cleanup: remove the proxy container. The network is
// left in place (empty, harmless) and reused by the next ensure.
export async function reapEgress(): Promise<void> {
  const existing = await findProxy();
  if (!existing) return;
  await getDocker()
    .getContainer(existing.Id)
    .remove({ force: true })
    .catch(() => undefined);
}

// Distinct hostnames the proxy has recently refused, newest first, read on
// demand from its logs (bounded tail, no streaming). Empty when no proxy runs.
export async function readEgressDenials(tail = 500): Promise<string[]> {
  const existing = await findProxy();
  if (!existing) return [];
  let raw: Buffer;
  try {
    const logs = await getDocker()
      .getContainer(existing.Id)
      .logs({ stdout: true, stderr: true, tail });
    raw = Buffer.isBuffer(logs) ? logs : Buffer.from(logs as unknown as string);
  } catch {
    return [];
  }
  const text = demuxOutput(raw);
  const seen: string[] = [];
  for (const line of text.split("\n").reverse()) {
    const match = /^BLOCKED (\S+)/.exec(line.trim());
    if (match && match[1] && !seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}
