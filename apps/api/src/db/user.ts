import { randomBytes } from "node:crypto";
import { getDb } from "./client.js";
import { hashToken } from "./tokens.js";

const USER_ID = "global";

export function getUserCredentials(): { email: string; hash: string } | null {
  const row = getDb()
    .prepare("SELECT email, hash FROM user WHERE id = ?")
    .get(USER_ID) as { email: string | null; hash: string | null } | undefined;
  if (!row?.hash || !row.email) return null;
  return { email: row.email, hash: row.hash };
}

export function saveUser(email: string, hash: string): void {
  getDb()
    .prepare(
      `INSERT INTO user (id, email, hash, updated_at)
       VALUES (@id, @email, @hash, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         hash = excluded.hash,
         updated_at = excluded.updated_at`,
    )
    .run({ id: USER_ID, email, hash, updatedAt: new Date().toISOString() });
}

export function getLoginVersion(): number {
  const row = getDb()
    .prepare("SELECT login_version FROM user WHERE id = ?")
    .get(USER_ID) as { login_version: number } | undefined;
  return row?.login_version ?? 0;
}

export function bumpLoginVersion(): void {
  getDb()
    .prepare(
      `INSERT INTO user (id, login_version, updated_at)
       VALUES (@id, 1, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         login_version = login_version + 1,
         updated_at = @updatedAt`,
    )
    .run({ id: USER_ID, updatedAt: new Date().toISOString() });
}

export function getIngestTokenHash(): string | null {
  const row = getDb()
    .prepare("SELECT ingest_token_hash FROM user WHERE id = ?")
    .get(USER_ID) as { ingest_token_hash: string | null } | undefined;
  return row?.ingest_token_hash ?? null;
}

function saveIngestTokenHash(hash: string): void {
  getDb()
    .prepare(
      `INSERT INTO user (id, ingest_token_hash, updated_at)
       VALUES (@id, @hash, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         ingest_token_hash = excluded.ingest_token_hash,
         updated_at = excluded.updated_at`,
    )
    .run({ id: USER_ID, hash, updatedAt: new Date().toISOString() });
}

// Generate the fleet-wide ingest credential. Returns the plaintext exactly
// once; the DB stores only its SHA-256 hash. Calling this again rotates the
// credential - the previous plaintext stops working immediately.
export function generateIngestToken(): string {
  const plaintext = "nwi_" + randomBytes(32).toString("base64url");
  saveIngestTokenHash(hashToken(plaintext));
  return plaintext;
}
