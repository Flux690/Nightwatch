import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { authSecretPath, secretKeyPath } from "./paths.js";
import { logger } from "./logger.js";

/* Two keys with two lifetimes: the encryption key protects credentials at rest,
   and the auth secret signs sessions. One value doing both welded them together. */
let encryption: string | null = null;
let auth: string | null = null;

// Publishing the key through process.env made the ordering an undeclared
// contract: import before boot and the failure named the env var, not why.
export function initSecrets(): void {
  encryption = resolveSecretKey();
  auth = resolveAuthSecret();
}

function activeSecret(): string {
  if (encryption === null) {
    throw new Error("secrets are not initialised; initSecrets() runs at boot");
  }
  return encryption;
}

// Handed to Better Auth, which signs session tokens with it.
export function authSecret(): string {
  if (auth === null) {
    throw new Error("secrets are not initialised; initSecrets() runs at boot");
  }
  return auth;
}

function deriveKey(): Buffer {
  return createHash("sha256").update(activeSecret()).digest();
}

// AES-256-GCM: iv (12 bytes) + authTag (16 bytes) + ciphertext, hex-encoded
// and dot-separated so the three parts are trivially split on decryption.
export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${tag.toString("hex")}.${ct.toString("hex")}`;
}

export function decrypt(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted value format");
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const key = deriveKey();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return (
    decipher.update(Buffer.from(ctHex, "hex")).toString("utf8") +
    decipher.final("utf8")
  );
}

// Never pass an encrypted blob here, only a plaintext key.
export function maskKey(plaintext: string): string {
  const suffix = plaintext.slice(-4);
  return `sk-...${suffix}`;
}

// Env wins, else a 0600 file is reused or generated. Losing the file is the
// same as rotating the variable.
function resolveKey(envVar: string, path: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;

  if (existsSync(path)) {
    const persisted = readFileSync(path, "utf8").trim();
    if (persisted) {
      logger.info({ path }, `loaded persisted ${envVar} file`);
      return persisted;
    }
    /* An empty file (crash mid-write, full disk, tampering) holds no recoverable
       key, so it is treated as absent rather than returned as "". */
    logger.warn({ path }, `${envVar} file is empty, generating a new one`);
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
  logger.info({ path }, `generated new ${envVar} file`);
  return generated;
}

export function resolveSecretKey(): string {
  return resolveKey("NIGHTWARDEN_SECRET_KEY", secretKeyPath());
}

export function resolveAuthSecret(): string {
  return resolveKey("NIGHTWARDEN_AUTH_SECRET", authSecretPath());
}
