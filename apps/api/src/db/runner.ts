import { randomBytes, createHash, randomUUID } from "node:crypto";
import { getDb } from "./client.js";

// Runner record stored in DB: the SHA-256 hash (hex) of the plaintext nwr_... credential.
// Plaintext is returned once at generation and never stored or logged.
export type RunnerRow = {
  id: string;
  tokenHash: string;
  label: string | null;
  serverName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

// Public view returned by the list endpoint: no hash, no plaintext.
export type RunnerMeta = {
  id: string;
  label: string | null;
  serverName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

// Generate a new runner token. Returns the plaintext exactly once; the DB
// stores only the SHA-256 hash. Format: nwr_ + 32 random bytes (base64url).
export function generateRunnerToken(
  label?: string,
  serverName?: string,
): { plaintext: string } & RunnerMeta {
  const plaintext = "nwr_" + randomBytes(32).toString("base64url");
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const db = getDb();

  const mint = db.transaction(() => {
    // A row with this server_name that never connected is an orphan from an
    // aborted setup - free it. A connected row is real, left for the UNIQUE 409.
    if (serverName !== undefined) {
      db.prepare(
        `DELETE FROM runner WHERE server_name = ? AND last_used_at IS NULL`,
      ).run(serverName);
    }
    db.prepare(
      `INSERT INTO runner (id, token, label, server_name, created_at)
       VALUES (@id, @tokenHash, @label, @serverName, @createdAt)`,
    ).run({
      id,
      tokenHash: hashToken(plaintext),
      label: label ?? null,
      serverName: serverName ?? null,
      createdAt,
    });
  });
  mint();

  return {
    plaintext,
    id,
    label: label ?? null,
    serverName: serverName ?? null,
    createdAt,
    lastUsedAt: null,
  };
}

const SELECT_ROW = `
  id,
  token             AS tokenHash,
  label,
  server_name       AS serverName,
  created_at        AS createdAt,
  last_used_at      AS lastUsedAt
`;

function mapRow(raw: Record<string, unknown>): RunnerRow {
  return {
    id: raw["id"] as string,
    tokenHash: raw["tokenHash"] as string,
    label: (raw["label"] as string | null) ?? null,
    serverName: (raw["serverName"] as string | null) ?? null,
    createdAt: raw["createdAt"] as string,
    lastUsedAt: (raw["lastUsedAt"] as string | null) ?? null,
  };
}

// Validate a plaintext token: hash it and look up.
export function findRunnerByToken(plaintext: string): RunnerRow | undefined {
  const raw = getDb()
    .prepare(`SELECT ${SELECT_ROW} FROM runner WHERE token = ?`)
    .get(hashToken(plaintext)) as Record<string, unknown> | undefined;
  return raw ? mapRow(raw) : undefined;
}

// Look up a runner record by its UUID (used by routes that receive the record id, not the plaintext).
export function findRunnerById(id: string): RunnerRow | undefined {
  const raw = getDb()
    .prepare(`SELECT ${SELECT_ROW} FROM runner WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return raw ? mapRow(raw) : undefined;
}

// Touch last_used_at on every authenticated use (WS connect, ingest, chat).
export function touchLastUsed(id: string): void {
  getDb()
    .prepare(`UPDATE runner SET last_used_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

// Delete a runner record by id (hard delete — no tombstone). Returns false if not found.
export function deleteRunner(id: string): boolean {
  const result = getDb().prepare(`DELETE FROM runner WHERE id = ?`).run(id);
  return result.changes > 0;
}

// Public list: no hash, no plaintext, newest first.
export function listRunnersMeta(): RunnerMeta[] {
  const rows = getDb()
    .prepare(`SELECT ${SELECT_ROW} FROM runner ORDER BY created_at DESC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const { tokenHash: _tokenHash, ...meta } = mapRow(r);
    return meta;
  });
}
