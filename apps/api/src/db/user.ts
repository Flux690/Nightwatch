import { randomBytes } from "node:crypto";
import { getDb } from "./client.js";
import { hashToken } from "./runner.js";
import { encrypt, decrypt } from "../config/crypto.js";

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

function saveIngestToken(hash: string, encrypted: string): void {
  getDb()
    .prepare(
      `INSERT INTO user (id, ingest_token_hash, ingest_token_encrypted, updated_at)
       VALUES (@id, @hash, @encrypted, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         ingest_token_hash = excluded.ingest_token_hash,
         ingest_token_encrypted = excluded.ingest_token_encrypted,
         updated_at = excluded.updated_at`,
    )
    .run({
      id: USER_ID,
      hash,
      encrypted,
      updatedAt: new Date().toISOString(),
    });
}

export function getIngestTokenPlaintext(): string | null {
  const row = getDb()
    .prepare("SELECT ingest_token_encrypted FROM user WHERE id = ?")
    .get(USER_ID) as { ingest_token_encrypted: string | null } | undefined;
  if (!row?.ingest_token_encrypted) return null;
  return decrypt(row.ingest_token_encrypted);
}

export function generateIngestToken(): string {
  const plaintext = "nwi_" + randomBytes(32).toString("base64url");
  saveIngestToken(hashToken(plaintext), encrypt(plaintext));
  return plaintext;
}
