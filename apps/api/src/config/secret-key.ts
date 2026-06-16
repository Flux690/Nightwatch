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

// Resolves SECRET_KEY for this boot (D16): an explicit env var always wins;
// otherwise a key file beside the SQLite database is reused or, on first
// boot, generated (0600) and reused from then on. Losing the file is
// equivalent to rotating SECRET_KEY: it invalidates every owner session and
// makes the stored, AES-GCM-wrapped LLM key undecryptable (which then reads
// back as unset) - the same consequence as rotating the env var by hand. The
// path (never the key material) is logged so that consequence shows up at
// boot instead of only in docs.
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
