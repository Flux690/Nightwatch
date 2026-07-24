import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
