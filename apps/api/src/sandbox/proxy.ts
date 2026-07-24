import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDocker } from "./docker.js";
import { SandboxUnavailableError } from "./errors.js";

export const PROXY_IMAGE = "nightwarden-tinyproxy";
export const PROXY_CONTAINER = "nightwarden-sandbox-proxy";
export const SANDBOX_NETWORK_NAME = "nightwarden-sandbox-net";
export const PROXY_LABEL = "nightwarden.proxy";
const CONFIG_HASH_LABEL = "nightwarden.proxy-config";
const PROXY_PORT = 8888;

// Built locally so no third-party proxy image enters the supply chain; Alpine
// maintains tinyproxy itself.
const DOCKERFILE = `FROM alpine:3.22
RUN apk add --no-cache tinyproxy
CMD ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
`;

export interface ProxyHandle {
  networkName: string;
  // Resolvable from inside the sandbox via the network's embedded DNS.
  proxyUrl: string;
}

function tinyproxyConf(subnet: string): string {
  return `User tinyproxy
Group tinyproxy
Port ${PROXY_PORT}
Listen 0.0.0.0
Timeout 600
MaxClients 64
Allow ${subnet}
ConnectPort 443
FilterType fnmatch
Filter "/etc/tinyproxy/filter"
FilterDefaultDeny Yes
LogLevel Notice
`;
}

async function ensureNetwork(): Promise<string> {
  const docker = getDocker();
  const existing = await docker.listNetworks({
    filters: JSON.stringify({ name: [SANDBOX_NETWORK_NAME] }),
  });
  const match = existing.find((n) => n.Name === SANDBOX_NETWORK_NAME);
  if (!match) {
    // Internal: containers on it have no route out except peers on the same
    // network - the dual-homed proxy is the only door.
    await docker.createNetwork({
      Name: SANDBOX_NETWORK_NAME,
      Internal: true,
      CheckDuplicate: true,
    });
  }
  const info = await docker.getNetwork(SANDBOX_NETWORK_NAME).inspect();
  const subnet = (info as { IPAM?: { Config?: Array<{ Subnet?: string }> } })
    .IPAM?.Config?.[0]?.Subnet;
  if (typeof subnet !== "string" || subnet.length === 0) {
    throw new SandboxUnavailableError(
      `network ${SANDBOX_NETWORK_NAME} has no subnet to allowlist`,
    );
  }
  return subnet;
}

async function ensureProxyImage(configDir: string): Promise<void> {
  const docker = getDocker();
  try {
    await docker.getImage(PROXY_IMAGE).inspect();
    return;
  } catch {
    // Missing locally - build below.
  }
  await writeFile(join(configDir, "Dockerfile"), DOCKERFILE);
  const stream = await docker.buildImage(
    { context: configDir, src: ["Dockerfile"] },
    { t: PROXY_IMAGE },
  );
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err, events) => {
      if (err) return reject(err);
      const failure = events?.find(
        (e) => typeof (e as { error?: unknown }).error === "string",
      );
      if (failure) {
        return reject(
          new SandboxUnavailableError(
            `tinyproxy image build failed: ${String((failure as { error: string }).error)}`,
          ),
        );
      }
      resolve();
    });
  });
}

// Idempotent per config: the running container is reused while its config-hash
// label matches; an allowlist edit recreates it on the next sandbox creation.
export async function ensureProxy(opts: {
  hosts: string[];
  configDir: string;
}): Promise<ProxyHandle> {
  const docker = getDocker();
  await mkdir(opts.configDir, { recursive: true });
  const subnet = await ensureNetwork();
  const conf = tinyproxyConf(subnet);
  const filter = opts.hosts.join("\n") + "\n";
  const hash = createHash("sha256")
    .update(DOCKERFILE)
    .update(conf)
    .update(filter)
    .digest("hex");

  const existing = docker.getContainer(PROXY_CONTAINER);
  try {
    const info = await existing.inspect();
    if (
      info.State.Running &&
      info.Config.Labels?.[CONFIG_HASH_LABEL] === hash
    ) {
      return {
        networkName: SANDBOX_NETWORK_NAME,
        proxyUrl: `http://${PROXY_CONTAINER}:${PROXY_PORT}`,
      };
    }
    await existing.remove({ force: true });
  } catch {
    // 404: no proxy yet - create below.
  }

  await ensureProxyImage(opts.configDir);
  await writeFile(join(opts.configDir, "tinyproxy.conf"), conf);
  await writeFile(join(opts.configDir, "filter"), filter);

  const container = await docker.createContainer({
    Image: PROXY_IMAGE,
    name: PROXY_CONTAINER,
    Labels: { [PROXY_LABEL]: "1", [CONFIG_HASH_LABEL]: hash },
    HostConfig: {
      Binds: [`${opts.configDir}:/etc/tinyproxy:ro`],
      RestartPolicy: { Name: "unless-stopped" },
    },
    NetworkingConfig: {
      EndpointsConfig: { [SANDBOX_NETWORK_NAME]: {} },
    },
  });
  // Dual-homed: the internal net serves the sandboxes, bridge provides egress.
  await docker.getNetwork("bridge").connect({ Container: container.id });
  await container.start();
  return {
    networkName: SANDBOX_NETWORK_NAME,
    proxyUrl: `http://${PROXY_CONTAINER}:${PROXY_PORT}`,
  };
}

export function proxyEnv(proxyUrl: string): string[] {
  // Both cases: CLI tools disagree on which spelling they read.
  return [
    `HTTP_PROXY=${proxyUrl}`,
    `HTTPS_PROXY=${proxyUrl}`,
    `http_proxy=${proxyUrl}`,
    `https_proxy=${proxyUrl}`,
    "NO_PROXY=localhost,127.0.0.1",
    "no_proxy=localhost,127.0.0.1",
  ];
}
