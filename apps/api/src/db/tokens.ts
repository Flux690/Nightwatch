import { randomBytes, createHash, randomUUID } from "node:crypto";
import { getDb } from "./client.js";

// Token stored in DB: the SHA-256 hash (hex) of the plaintext nwr_... credential.
// Plaintext is returned once at generation and never stored or logged.
export type TokenRow = {
  id: string;
  tokenHash: string;
  runnerId: string | null;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

// Public view returned by the list endpoint: no hash, no plaintext.
export type TokenMeta = {
  id: string;
  runnerId: string | null;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

// Generate a new runner token. Returns the plaintext exactly once; the DB
// stores only the SHA-256 hash. Format: nwr_ + 32 random bytes (base64url).
export function generateToken(label?: string): { plaintext: string } & TokenMeta {
  const plaintext = "nwr_" + randomBytes(32).toString("base64url");
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  getDb()
    .prepare(
      `INSERT INTO tokens (id, token, label, created_at)
       VALUES (@id, @tokenHash, @label, @createdAt)`,
    )
    .run({
      id,
      tokenHash: hashToken(plaintext),
      label: label ?? null,
      createdAt,
    });

  return {
    plaintext,
    id,
    runnerId: null,
    label: label ?? null,
    createdAt,
    lastUsedAt: null,

  };
}

const SELECT_ROW = `
  id,
  token       AS tokenHash,
  runner_id   AS runnerId,
  label,
  created_at  AS createdAt,
  last_used_at AS lastUsedAt
`;

export function setTokenRunnerId(id: string, runnerId: string): void {
  getDb()
    .prepare(`UPDATE tokens SET runner_id = ? WHERE id = ?`)
    .run(runnerId, id);
}

// Validate a plaintext token: hash it and look up.
export function findTokenByValue(plaintext: string): TokenRow | undefined {
  return getDb()
    .prepare(
      `SELECT ${SELECT_ROW} FROM tokens WHERE token = ?`,
    )
    .get(hashToken(plaintext)) as TokenRow | undefined;
}

// Look up a token by its UUID (used by routes that receive the token ID, not the plaintext).
export function findTokenById(id: string): TokenRow | undefined {
  return getDb()
    .prepare(
      `SELECT ${SELECT_ROW} FROM tokens WHERE id = ?`,
    )
    .get(id) as TokenRow | undefined;
}

// Touch last_used_at on every authenticated use (WS connect, ingest, chat).
export function touchLastUsed(id: string): void {
  getDb()
    .prepare(`UPDATE tokens SET last_used_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

// Delete a runner token by id (hard delete — no tombstone). Returns false if not found.
export function deleteToken(id: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM tokens WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

// Public list: no hash, no plaintext, newest first.
export function listTokensMeta(): TokenMeta[] {
  return getDb()
    .prepare(
      `SELECT id, label, created_at AS createdAt,
              runner_id AS runnerId, last_used_at AS lastUsedAt
       FROM tokens ORDER BY created_at DESC`,
    )
    .all() as TokenMeta[];
}
