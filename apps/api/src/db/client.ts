import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { dbPath } from "../env/paths.js";

// No migrations: a schema change is applied by recreating the database.
const SCHEMA = `

CREATE TABLE IF NOT EXISTS runner (
  id             TEXT     PRIMARY KEY,
  token          TEXT     NOT NULL UNIQUE,
  platform       TEXT     NOT NULL CHECK (platform IN ('docker', 'kubernetes')),
  label          TEXT,
  server_name    TEXT     UNIQUE,
  created_at     TEXT     NOT NULL,
  last_used_at   TEXT
);

CREATE TABLE IF NOT EXISTS config (
  id                        TEXT      PRIMARY KEY,
  active_provider           TEXT,
  max_retries               INTEGER   NOT NULL DEFAULT 3,
  request_timeout_ms        INTEGER   NOT NULL DEFAULT 120000,
  max_concurrent_investigations INTEGER NOT NULL DEFAULT 10,
  check_in_after_ms         INTEGER   NOT NULL DEFAULT 1800000,
  tool_call_ceiling_ms      INTEGER   NOT NULL DEFAULT 600000,
  sandbox_idle_timeout_ms   INTEGER   NOT NULL DEFAULT 3600000,
  sandbox_cpus              INTEGER   NOT NULL DEFAULT 2,
  sandbox_memory_mb         INTEGER   NOT NULL DEFAULT 4096,
  sandbox_require_gvisor    INTEGER   NOT NULL DEFAULT 0,
  sandbox_network           TEXT      NOT NULL DEFAULT 'allowlist',
  sandbox_allowlist_hosts   TEXT      NOT NULL DEFAULT 'registry.npmjs.org
registry.yarnpkg.com
repo.yarnpkg.com',
  updated_at                TEXT      NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_config (
  provider            TEXT      PRIMARY KEY,
  model               TEXT,
  base_url            TEXT,
  api_key_encrypted   TEXT,
  reasoning_level     TEXT,
  max_output_tokens   INTEGER,
  max_input_tokens    INTEGER,
  compaction          INTEGER   NOT NULL DEFAULT 0,
  reasoning           TEXT,
  updated_at          TEXT      NOT NULL
);

CREATE TABLE IF NOT EXISTS user (
  id              TEXT      PRIMARY KEY,
  email           TEXT,
  hash            TEXT,
  login_version   INTEGER   NOT NULL DEFAULT 0,
  updated_at      TEXT      NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_sources (
  kind                TEXT   PRIMARY KEY,
  token_hash          TEXT   NOT NULL UNIQUE,
  token_encrypted     TEXT   NOT NULL,
  last_received_at    TEXT,
  created_at          TEXT   NOT NULL
);

-- Its own table rather than a row in integrations, for the reason alert_sources
-- has one: the shape differs. There are many of these, and each holds two
-- addresses and two credentials - a rules API often lives on another host
-- behind another token, which one config blob and one secret cannot express.
CREATE TABLE IF NOT EXISTS metrics_backends (
  id                    TEXT   PRIMARY KEY,
  kind                  TEXT   NOT NULL,
  -- Unique because it is how a tool call addresses one, the way a runner is
  -- addressed by its name. Two backends a model cannot tell apart is a
  -- configuration the connect route refuses rather than one we resolve.
  label                 TEXT   NOT NULL UNIQUE,
  query_url             TEXT   NOT NULL,
  query_auth_encrypted  TEXT,
  query_org_id          TEXT,
  -- Null when this backend serves no rules API we can reach. Recorded rather
  -- than inferred: it is the difference between an alert that can be confirmed
  -- recovered and one that never can.
  rules_url             TEXT,
  rules_auth_encrypted  TEXT,
  rules_org_id          TEXT,
  validated_at          TEXT   NOT NULL,
  created_at            TEXT   NOT NULL
);

CREATE TABLE IF NOT EXISTS integrations (
  kind                TEXT   PRIMARY KEY,
  config              TEXT   NOT NULL,
  secret_encrypted    TEXT,
  validated_at        TEXT   NOT NULL,
  created_at          TEXT   NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id           TEXT      PRIMARY KEY,
  title                TEXT      NOT NULL DEFAULT '',
  investigation        INTEGER   NOT NULL DEFAULT 0,
  run_state            TEXT      NOT NULL DEFAULT 'done'
                                 CHECK (run_state IN ('running', 'suspended', 'done')),
  failed_attempts      INTEGER   NOT NULL DEFAULT 0,
  failure_kind         TEXT      CHECK (failure_kind IN ('transient', 'permanent')),
  report               TEXT,
  created_at           TEXT      NOT NULL,
  last_activity_at     TEXT      NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_kind_activity
  ON sessions(investigation, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_seats
  ON sessions(investigation, run_state);

CREATE TABLE IF NOT EXISTS alerts (
  id                 INTEGER   PRIMARY KEY,
  session_id         TEXT      REFERENCES sessions(session_id) ON DELETE CASCADE,
  group_key          TEXT      NOT NULL,
  source_alert_id    TEXT      NOT NULL,
  fired_at           TEXT      NOT NULL,
  arrived_at         TEXT      NOT NULL,
  cleared_at         TEXT,
  injected           INTEGER   NOT NULL DEFAULT 0,
  dropped_alerts     INTEGER   NOT NULL DEFAULT 0,
  group_context      TEXT,
  alert              TEXT      NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_session
  ON alerts(session_id, id);
CREATE INDEX IF NOT EXISTS idx_alerts_source
  ON alerts(source_alert_id, fired_at);
CREATE INDEX IF NOT EXISTS idx_alerts_open
  ON alerts(session_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_queued
  ON alerts(arrived_at) WHERE session_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_group
  ON alerts(group_key);

CREATE TABLE IF NOT EXISTS session_transcript (
  session_id     TEXT      NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  seq            INTEGER   NOT NULL,
  kind           TEXT      NOT NULL,
  content        TEXT      NOT NULL,
  canonical      TEXT,
  timestamp      TEXT      NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS pending_human_input (
  session_id            TEXT   NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_use_id           TEXT   NOT NULL,
  kind                  TEXT   NOT NULL DEFAULT 'approval',
  completed_results     TEXT   NOT NULL DEFAULT '[]',
  claimed_at            TEXT,
  PRIMARY KEY (session_id)
);

`;

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!_db) {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    // Off by default in SQLite, so ON DELETE CASCADE fires only once it is on.
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
    _db = db;
  }
  return _db;
}

// Eager, so a misconfigured data path fails at boot rather than at 3am.
export function initDb(): void {
  getDb();
}

export function resetDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
