import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// One absolute directory holds all durable machine-local state. A relative NIGHTWATCH_DIR
// is rejected rather than resolved against the cwd (a hidden guess).
export function nightwatchDir(): string {
  const explicit = process.env["NIGHTWATCH_DIR"];
  if (explicit === undefined || explicit === "") {
    return join(homedir(), ".nightwatch");
  }
  if (!isAbsolute(explicit)) {
    throw new Error(
      `NIGHTWATCH_DIR must be an absolute path, got: ${explicit}`,
    );
  }
  return explicit;
}

export function dbPath(): string {
  return join(nightwatchDir(), "nightwatch.db");
}

export function secretKeyPath(): string {
  return join(nightwatchDir(), "secret.key");
}

// Absolute so the Docker bind mount accepts it (a relative source reads as a
// named volume).
export function workspacesDir(): string {
  return join(nightwatchDir(), "workspaces");
}
