import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

// D1: single SQLite source of record. Lazy open so tests can set NIGHTWATCH_DB_PATH before
// first query; exported so D16 self-provisioning can place the key file beside the database.
export function dbPath(): string {
  return process.env["NIGHTWATCH_DB_PATH"] ?? "/var/nightwatch/nightwatch.db";
}

// The schema is the single source of truth - the final desired shape, created
// directly. There are no upgrade migrations: this is a pre-production project, so
// a schema change is applied by recreating the database, not by migrating data.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runner (
    id                TEXT PRIMARY KEY,
    token             TEXT NOT NULL UNIQUE,
    runner_id         TEXT,
    label             TEXT,
    server_name       TEXT UNIQUE,
    remediation_mode  INTEGER,
    created_at        TEXT NOT NULL,
    last_used_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS config (
    id                 TEXT PRIMARY KEY,
    provider           TEXT NOT NULL DEFAULT 'anthropic',
    model              TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
    thinking           TEXT NOT NULL DEFAULT 'adaptive',
    max_output_tokens  INTEGER NOT NULL DEFAULT 32000,
    max_retries        INTEGER NOT NULL DEFAULT 2,
    request_timeout_ms INTEGER NOT NULL DEFAULT 120000,
    hard_timeout_ms    INTEGER NOT NULL DEFAULT 300000,
    tool_timeout_ms    INTEGER NOT NULL DEFAULT 15000,
    remediation_breaker_limit     INTEGER NOT NULL DEFAULT 5,
    remediation_breaker_window_ms INTEGER NOT NULL DEFAULT 600000,
    base_url           TEXT,
    api_key_encrypted  TEXT,
    prompt_caching     INTEGER NOT NULL DEFAULT 1,
    reasoning_effort   TEXT,
    updated_at         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user (
    id                TEXT PRIMARY KEY,
    email             TEXT,
    hash              TEXT,
    login_version     INTEGER NOT NULL DEFAULT 0,
    ingest_token_hash      TEXT,
    ingest_token_encrypted TEXT,
    updated_at             TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id        TEXT PRIMARY KEY,
    title             TEXT NOT NULL DEFAULT '',
    originating_alert TEXT,
    created_at        TEXT NOT NULL
  );

  -- A session's transcript and any pending approval ARE part of the session, so
  -- they cascade-delete with it (foreign_keys is enabled below).
  CREATE TABLE IF NOT EXISTS session_messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    seq              INTEGER NOT NULL,
    role             TEXT NOT NULL,
    content          TEXT NOT NULL,
    provider_content TEXT,
    created_at       TEXT NOT NULL,
    UNIQUE(session_id, seq)
  );

  CREATE TABLE IF NOT EXISTS pending_human_input (
    session_id        TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    tool_use_id       TEXT NOT NULL,
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

  -- The remediation audit log is intentionally NOT a child of sessions: it is the
  -- durable record of what was changed and must outlive a deleted session, so
  -- session_id is a plain historical reference, not a cascading foreign key.
  CREATE TABLE IF NOT EXISTS remediation_actions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_use_id          TEXT NOT NULL,
    session_id           TEXT NOT NULL,
    tool_name            TEXT NOT NULL,
    service_identity_key TEXT,
    status               TEXT NOT NULL,
    resolved_by          TEXT,
    input                TEXT NOT NULL,
    result               TEXT,
    created_at           TEXT NOT NULL,
    resolved_at          TEXT,
    UNIQUE (session_id, tool_use_id)
  );

  -- Covers the circuit-breaker count, which filters on exactly these columns on
  -- every write-approval; without it that check full-scans the audit history.
  CREATE INDEX IF NOT EXISTS idx_remediation_breaker
    ON remediation_actions(service_identity_key, tool_name, status, created_at);

  CREATE TABLE IF NOT EXISTS unresolved_alerts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source_alert_id  TEXT NOT NULL UNIQUE,
    identity_key     TEXT NOT NULL,
    alert_type       TEXT NOT NULL,
    severity         TEXT NOT NULL,
    rejection_reason TEXT NOT NULL,
    created_at       TEXT NOT NULL
  );
`;

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!_db) {
    const path = dbPath();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    // Enforce the declared foreign keys (off by default in SQLite); this is what
    // makes ON DELETE CASCADE fire and forbids orphan rows.
    db.pragma("foreign_keys = ON");
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
