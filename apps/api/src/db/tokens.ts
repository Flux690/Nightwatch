import { randomUUID } from "node:crypto";
import { getDb } from "./client.js";

// A deployment token row. For issue 019 the token value is still an opaque
// random string stored in plaintext; the nwr_-prefix + SHA-256 hashing and the
// label/lastUsedAt/revokedAt lifecycle land in issue 025.
export type TokenRow = {
  id: string;
  token: string;
  hostname: string | null;
  createdAt: string;
};

// Every read selects these aliased columns, so the untyped better-sqlite3 rows
// line up with TokenRow; the `as TokenRow` casts below are sound for that reason.
const SELECT_COLS = `id, token, hostname, created_at AS createdAt`;

export function createToken(hostname: string | null = null): TokenRow {
  const row: TokenRow = {
    id: randomUUID(),
    token: randomUUID(),
    hostname,
    createdAt: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `INSERT INTO tokens (id, token, hostname, created_at)
       VALUES (@id, @token, @hostname, @createdAt)`,
    )
    .run(row);
  return row;
}

export function findTokenByValue(token: string): TokenRow | undefined {
  // Cast is sound: SELECT_COLS aliases the row to TokenRow (see above).
  return getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM tokens WHERE token = ?`)
    .get(token) as TokenRow | undefined;
}

// The single deployment token (D5): GET /token returns the earliest one, minting
// lazily if none exists yet.
export function oldestToken(): TokenRow | undefined {
  // Cast is sound: SELECT_COLS aliases the row to TokenRow (see above).
  return getDb()
    .prepare(
      `SELECT ${SELECT_COLS} FROM tokens ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as TokenRow | undefined;
}

export function listTokens(): TokenRow[] {
  // Cast is sound: SELECT_COLS aliases the rows to TokenRow (see above).
  return getDb()
    .prepare(`SELECT ${SELECT_COLS} FROM tokens ORDER BY created_at DESC`)
    .all() as TokenRow[];
}

// Runners report their hostname in the manifest after connecting; record it
// against the token they authenticated with.
export function setTokenHostname(token: string, hostname: string | null): void {
  getDb()
    .prepare(`UPDATE tokens SET hostname = ? WHERE token = ?`)
    .run(hostname, token);
}
