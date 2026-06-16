import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

// The API's SQLite file is the single system of record (architecture invariant
// D1). One file, WAL mode, idempotent DDL bootstrapped on first open - the same
// pattern the runner uses for its history db. Postgres/Prisma are gone.
// Resolved lazily (inside getDb) so tests can set NIGHTWATCH_DB_PATH before the
// connection opens. Exported so the SECRET_KEY self-provisioning (D16) can
// place the key file beside the database without a second source of truth for
// the data directory.
export function dbPath(): string {
  return process.env["NIGHTWATCH_DB_PATH"] ?? "/var/nightwatch/nightwatch.db";
}

// Tables land here as the refactor proceeds; issue 019 introduces the first two
// (tokens, config); issue 020 adds sessions, session_messages, and incidents as
// part of the state inversion (the runner is now stateless). Each statement is
// CREATE TABLE IF NOT EXISTS so the bootstrap is safe to run on every boot.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tokens (
    id           TEXT PRIMARY KEY,
    token        TEXT NOT NULL UNIQUE,
    label        TEXT,
    created_at   TEXT NOT NULL,
    last_used_at TEXT
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
    owner_email        TEXT,
    owner_hash         TEXT,
    login_version      INTEGER NOT NULL DEFAULT 0,
    updated_at         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id        TEXT PRIMARY KEY,
    token             TEXT NOT NULL,
    title             TEXT NOT NULL DEFAULT '',
    originating_alert TEXT,
    created_at        TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_token
    ON sessions(token, created_at);

  CREATE TABLE IF NOT EXISTS session_messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT NOT NULL REFERENCES sessions(session_id),
    seq              INTEGER NOT NULL,
    role             TEXT NOT NULL,
    content          TEXT NOT NULL,
    provider_content TEXT,
    created_at       TEXT NOT NULL,
    UNIQUE(session_id, seq)
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id                    TEXT PRIMARY KEY,
    token                 TEXT NOT NULL,
    session_id            TEXT,
    outcome               TEXT NOT NULL DEFAULT 'finding',
    timestamp             TEXT NOT NULL,
    container_name        TEXT NOT NULL,
    alert_type            TEXT NOT NULL,
    root_cause            TEXT NOT NULL DEFAULT '',
    resolution_action     TEXT,
    resolved_at           TEXT,
    human_resolution_note TEXT,
    recurrence_count      INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_incidents_lookup
    ON incidents(token, container_name, alert_type, timestamp);

  CREATE TABLE IF NOT EXISTS pending_interrupts (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES sessions(session_id),
    tool_use_id       TEXT NOT NULL UNIQUE,
    kind              TEXT NOT NULL DEFAULT 'approval',
    tool_name         TEXT NOT NULL,
    tool_input        TEXT NOT NULL,
    completed_results TEXT NOT NULL DEFAULT '[]',
    created_at        TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pending_interrupts_session
    ON pending_interrupts(session_id);
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

// Close and clear the singleton. Used by tests to get a truly fresh connection
// between suites when NIGHTWATCH_DB_PATH is re-stubbed.
export function resetDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
