import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// One absolute directory holds all durable machine-local state. A relative NIGHTWARDEN_DIR
// is rejected rather than resolved against the cwd (a hidden guess).
export function nightwardenDir(): string {
  const explicit = process.env["NIGHTWARDEN_DIR"];
  if (explicit === undefined || explicit === "") {
    return join(homedir(), ".nightwarden");
  }
  if (!isAbsolute(explicit)) {
    throw new Error(
      `NIGHTWARDEN_DIR must be an absolute path, got: ${explicit}`,
    );
  }
  return explicit;
}

export function dbPath(): string {
  return join(nightwardenDir(), "nightwarden.db");
}

export function secretKeyPath(): string {
  return join(nightwardenDir(), "secret.key");
}

// Absolute so the Docker bind mount accepts it (a relative source reads as a
// named volume).
export function workspacesDir(): string {
  return join(nightwardenDir(), "workspaces");
}

export function proxyDir(): string {
  return join(nightwardenDir(), "proxy");
}

// Mount points as the kernel sees them; field 5 is the mount path.
function mountPoints(): Set<string> {
  try {
    const lines = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
    return new Set(lines.map((l) => l.split(" ")[4]).filter((p) => p != null));
  } catch {
    return new Set();
  }
}

// State on the container's writable layer dies with the container, taking the
// database and secret key with it. Worth refusing to boot over.
export function stateDirIsEphemeral(dir: string): boolean {
  if (!existsSync("/.dockerenv")) return false;
  const mounts = mountPoints();
  if (mounts.size === 0) return false;
  for (let path = dir; path !== "/"; path = dirname(path)) {
    if (mounts.has(path)) return false;
  }
  return true;
}
