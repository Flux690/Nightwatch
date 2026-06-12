import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// Derive a stable 32-byte key from the SECRET_KEY env var via SHA-256.
// The env var can be any length; the hash normalises it to exactly 32 bytes.
function deriveKey(): Buffer {
  const secret = process.env["SECRET_KEY"];
  if (!secret) throw new Error("SECRET_KEY is not set");
  return createHash("sha256").update(secret).digest();
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

// Returns a display-safe representation: "sk-...XXXX" (last 4 chars only).
// Callers must never pass encrypted blobs here — only plaintext keys.
export function maskKey(plaintext: string): string {
  const suffix = plaintext.slice(-4);
  return `sk-...${suffix}`;
}
