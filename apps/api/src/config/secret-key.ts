import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { dbPath } from "../db/client.js";
import { logger } from "../logger.js";

function keyFilePath(): string {
  return join(dirname(dbPath()), "secret.key");
}

// Resolves SECRET_KEY (D16): an env var wins, else a 0600 key file beside the DB is reused
// or generated on first boot. Losing it equals rotating SECRET_KEY - sessions invalidate and
// the wrapped LLM key becomes undecryptable. The path (never the key) is logged at boot.
export function resolveSecretKey(): string {
  const envKey = process.env["SECRET_KEY"];
  if (envKey) return envKey;

  const path = keyFilePath();
  if (existsSync(path)) {
    const persisted = readFileSync(path, "utf8").trim();
    if (persisted) {
      logger.info({ path }, "loaded persisted SECRET_KEY file");
      return persisted;
    }
    // Crash mid-write, full disk, or manual tampering - an empty file has no
    // recoverable key in it, so treat it the same as absent rather than
    // handing back "" and letting it fail later as a confusing signing error.
    logger.warn({ path }, "SECRET_KEY file is empty, generating a new one");
  }

  const generated = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generated, { mode: 0o600 });
  if (platform() === "win32") {
    // 0o600 is ignored on Windows; restrict via ACL: remove inheritance, grant
    // only the current user full control so other local accounts cannot read it.
    execSync(`icacls "${path}" /inheritance:r /grant:r "%USERNAME%":F`, { stdio: "ignore" });
  }
  logger.info({ path }, "generated new SECRET_KEY file");
  return generated;
}
