import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { secretKeyPath } from "./paths.js";
import { logger } from "../logger.js";

// Resolves SECRET_KEY: env var wins, else a 0600 key file in the state dir is
// reused or generated on first boot. Losing it equals rotating SECRET_KEY.
export function resolveSecretKey(): string {
  const envKey = process.env["SECRET_KEY"];
  if (envKey) return envKey;

  const path = secretKeyPath();
  if (existsSync(path)) {
    const persisted = readFileSync(path, "utf8").trim();
    if (persisted) {
      logger.info({ path }, "loaded persisted SECRET_KEY file");
      return persisted;
    }
    // An empty file (crash mid-write, full disk, tampering) has no recoverable key,
    // so treat it as absent rather than returning "" and failing later as a confusing signing error.
    logger.warn({ path }, "SECRET_KEY file is empty, generating a new one");
  }

  const generated = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generated, { mode: 0o600 });
  if (platform() === "win32") {
    // 0o600 is ignored on Windows; restrict via ACL: remove inheritance, grant
    // only the current user full control so other local accounts cannot read it.
    execSync(`icacls "${path}" /inheritance:r /grant:r "%USERNAME%":F`, {
      stdio: "ignore",
    });
  }
  logger.info({ path }, "generated new SECRET_KEY file");
  return generated;
}
