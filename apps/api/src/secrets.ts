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
import { secretKeyPath } from "./paths.js";
import { logger } from "./logger.js";

// Every credential stored at rest passes through here: provider keys,
// integration tokens, the fleet ingest token, and the owner session signature.
let secret: string | null = null;

// Publishing the key through process.env made the ordering an undeclared
// contract: import before boot and the failure named the env var, not why.
export function initSecrets(): void {
  secret = resolveSecretKey();
}

function activeSecret(): string {
  if (secret === null) {
    throw new Error("secrets are not initialised; initSecrets() runs at boot");
  }
  return secret;
}

// jose signs with the raw value; AES needs exactly 32 bytes, which the hash gives.
export function signingSecret(): string {
  return activeSecret();
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

// Resolves NIGHTWARDEN_SECRET_KEY: env var wins, else a 0600 key file in the state dir is
// reused or generated on first boot. Losing it equals rotating NIGHTWARDEN_SECRET_KEY.
export function resolveSecretKey(): string {
  const envKey = process.env["NIGHTWARDEN_SECRET_KEY"];
  if (envKey) return envKey;

  const path = secretKeyPath();
  if (existsSync(path)) {
    const persisted = readFileSync(path, "utf8").trim();
    if (persisted) {
      logger.info({ path }, "loaded persisted NIGHTWARDEN_SECRET_KEY file");
      return persisted;
    }
    // An empty file (crash mid-write, full disk, tampering) has no recoverable key,
    // so treat it as absent rather than returning "" and failing later as a confusing signing error.
    logger.warn(
      { path },
      "NIGHTWARDEN_SECRET_KEY file is empty, generating a new one",
    );
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
  logger.info({ path }, "generated new NIGHTWARDEN_SECRET_KEY file");
  return generated;
}
