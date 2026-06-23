import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

// D1: single SQLite source of record. Lazy open so tests can set NIGHTWATCH_DB_PATH before
// first query; exported so D16 self-provisioning can place the key file beside the database.
export function dbPath(): string {
  return process.env["NIGHTWATCH_DB_PATH"] ?? "/var/nightwatch/nightwatch.db";
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tokens (
    id           TEXT PRIMARY KEY,
    token        TEXT NOT NULL UNIQUE,
    runner_id    TEXT,
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
    remediation_breaker_limit     INTEGER NOT NULL DEFAULT 5,
    remediation_breaker_window_ms INTEGER NOT NULL DEFAULT 600000,
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
    title             TEXT NOT NULL DEFAULT '',
    originating_alert TEXT,
    created_at        TEXT NOT NULL
  );

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

  CREATE TABLE IF NOT EXISTS pending_human_input (
    session_id        TEXT NOT NULL REFERENCES sessions(session_id),
    tool_use_id       TEXT NOT NULL UNIQUE,
    kind              TEXT NOT NULL DEFAULT 'approval',
    tool_name         TEXT NOT NULL,
    tool_input        TEXT NOT NULL,
    completed_results TEXT NOT NULL DEFAULT '[]',
    claimed_at        TEXT,
    created_at        TEXT NOT NULL,
    PRIMARY KEY (session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_pending_human_input_claimed
    ON pending_human_input(claimed_at);

  CREATE TABLE IF NOT EXISTS remediation_actions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_use_id          TEXT NOT NULL UNIQUE,
    session_id           TEXT NOT NULL REFERENCES sessions(session_id),
    tool_name            TEXT NOT NULL,
    service_identity_key TEXT,
    status               TEXT NOT NULL,
    input                TEXT NOT NULL,
    result               TEXT,
    created_at           TEXT NOT NULL,
    resolved_at          TEXT
  );
`;

let _db: Database.Database | undefined;

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
  const db = getDb();
  db.prepare(`UPDATE pending_human_input SET claimed_at = NULL`).run();
}

export function resetDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
