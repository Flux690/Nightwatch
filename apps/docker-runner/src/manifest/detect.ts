import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import {
  deriveDockerServiceIdentity,
  dockerServiceKey,
  type DockerManifest,
  type DockerServiceEntry,
} from "@nightwarden/shared";
import { getDocker, listVisibleContainers } from "../docker/client.js";
import { PROC_PATH } from "../commands/host.js";

// The root package.json version, inlined at build time. "dev" under tsx, which
// runs from source and so has no build step to inline anything.
const RUNNER_VERSION = process.env.NW_VERSION ?? "dev";

// No probing: this binary is a Docker runner, so an unreachable daemon is a
// failure to report, not a reason to go looking for something else to be.
export async function buildDockerManifest(): Promise<DockerManifest> {
  const [host, services] = await Promise.all([
    detectHostname(),
    listServices(),
  ]);

  return {
    platform: "docker",
    hostname: host,
    runnerVersion: RUNNER_VERSION,
    services,
  };
}

// os.hostname() inside a container is the container id unless --hostname was passed,
// and this string becomes the address the model types into `runner`. Host /proc is
// already mounted for the host metrics, so the real name costs no new mount.
async function detectHostname(): Promise<string> {
  try {
    const name = (
      await readFile(`${PROC_PATH}/sys/kernel/hostname`, "utf8")
    ).trim();
    if (name) return name;
  } catch {
    // Not containerized, or /proc is not readable: the OS name is already correct.
  }
  return hostname();
}

async function listServices(): Promise<DockerServiceEntry[]> {
  const docker = getDocker();
  // `all: true` so a service whose only container is currently stopped is still advertised - otherwise
  // routing would reject the call before the runner ever gets to JIT-resolve it and report a clean finding.
  const list = await listVisibleContainers(docker);
  const byKey = new Map<string, DockerServiceEntry>();
  for (const c of list) {
    const name = (c.Names[0] ?? "").replace(/^\//, "");
    const identity = deriveDockerServiceIdentity(c.Labels, name);
    const target = dockerServiceKey(identity);
    const existing = byKey.get(target);
    // Prefer "running" over any stopped state when multiple containers share an identity (e.g. scaled
    // Compose replicas or a restarted container that left a stopped predecessor in the list).
    if (!existing || existing.status !== "running") {
      byKey.set(target, { identity, target, status: c.State });
    }
  }
  return [...byKey.values()];
}
