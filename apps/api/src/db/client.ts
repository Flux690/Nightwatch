import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

// The API's SQLite file is the single system of record (architecture invariant
// D1). One file, WAL mode, idempotent DDL bootstrapped on first open - the same
// pattern the runner uses for its history db. Postgres/Prisma are gone.
// Resolved lazily (inside getDb) so tests can set NIGHTWATCH_DB_PATH before the
// connection opens.
function dbPath(): string {
  return process.env["NIGHTWATCH_DB_PATH"] ?? "/var/nightwatch/nightwatch.db";
}

// Tables land here as the refactor proceeds; issue 019 introduces the first two
// (tokens, config). Sessions, transcripts, incidents, and pending interrupts
// follow in later issues. Each statement is CREATE TABLE IF NOT EXISTS so the
// bootstrap is safe to run on every boot.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tokens (
    id         TEXT PRIMARY KEY,
    token      TEXT NOT NULL UNIQUE,
    hostname   TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config (
    id                 TEXT PRIMARY KEY,
    provider           TEXT NOT NULL DEFAULT 'anthropic',
    model              TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    thinking           TEXT NOT NULL DEFAULT 'adaptive',
    max_output_tokens  INTEGER NOT NULL DEFAULT 32000,
    max_retries        INTEGER NOT NULL DEFAULT 2,
    request_timeout_ms INTEGER NOT NULL DEFAULT 120000,
    max_tool_calls     INTEGER NOT NULL DEFAULT 24,
    hard_timeout_ms    INTEGER NOT NULL DEFAULT 300000,
    tool_timeout_ms    INTEGER NOT NULL DEFAULT 15000,
    base_url           TEXT,
    api_key_encrypted  TEXT,
    prompt_caching     INTEGER NOT NULL DEFAULT 1,
    reasoning_effort   TEXT,
    updated_at         TEXT NOT NULL
  );
`;

let _db: Database.Database | undefined;

// Lazily open the connection so tests can point NIGHTWATCH_DB_PATH at a throwaway
// file before the first query, and so importing this module never touches disk.
export function getDb(): Database.Database {
  if (!_db) {
    const path = dbPath();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    _db = db;
  }
  return _db;
}

// Open + bootstrap eagerly at boot so a misconfigured data path fails fast
// rather than on the first request.
export function initDb(): void {
  getDb();
}
