import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { dbPath } from "../env/paths.js";

// No upgrade migrations: pre-production, so a schema change is applied by
// recreating the database, not by migrating data.
const SCHEMA = `

-- The fleet: one row per installed runner.

-- platform is what this runner IS, fixed at onboarding. It is never derived from
-- what the runner reports, so the row is authoritative before it ever connects;
-- the CHECK makes a typo a write failure rather than a runner that matches nothing.
CREATE TABLE IF NOT EXISTS runner (
  id             TEXT     PRIMARY KEY,
  token          TEXT     NOT NULL UNIQUE,
  platform       TEXT     NOT NULL CHECK (platform IN ('docker', 'kubernetes')),
  label          TEXT,
  server_name    TEXT     UNIQUE,
  created_at     TEXT     NOT NULL,
  last_used_at   TEXT
);


-- Configuration: how the loop behaves, and how to reach one model.

-- Loop and sandbox policy, which is provider-independent. Anything that
-- describes how to reach one model lives in provider_config below.
CREATE TABLE IF NOT EXISTS config (
  id                        TEXT      PRIMARY KEY,
  -- Which provider_config row is live. NULL means the operator has not picked
  -- yet, which the run gate refuses on; a default would make a fresh install
  -- look configured while holding no API key.
  active_provider           TEXT,
  max_retries               INTEGER   NOT NULL DEFAULT 3,
  request_timeout_ms        INTEGER   NOT NULL DEFAULT 120000,
  check_in_after_ms         INTEGER   NOT NULL DEFAULT 1800000,
  tool_call_ceiling_ms      INTEGER   NOT NULL DEFAULT 600000,
  sandbox_idle_timeout_ms   INTEGER   NOT NULL DEFAULT 3600000,
  sandbox_cpus              INTEGER   NOT NULL DEFAULT 2,
  sandbox_memory_mb         INTEGER   NOT NULL DEFAULT 4096,
  sandbox_require_gvisor    INTEGER   NOT NULL DEFAULT 0,
  sandbox_network           TEXT      NOT NULL DEFAULT 'allowlist',
  -- One host per line, so the continuation lines are flush left on purpose:
  -- indenting them would put leading spaces inside the stored default.
  sandbox_allowlist_hosts   TEXT      NOT NULL DEFAULT 'registry.npmjs.org
registry.yarnpkg.com
repo.yarnpkg.com',
  updated_at                TEXT      NOT NULL
);

-- One row per provider, so switching the active one cannot carry the previous
-- one's key or base URL across. The catalog facts are captured when the model
-- is saved, so starting a run never has to reach the network.
CREATE TABLE IF NOT EXISTS provider_config (
  provider            TEXT      PRIMARY KEY,
  model               TEXT,
  base_url            TEXT,
  api_key_encrypted   TEXT,
  reasoning_level     TEXT,
  max_output_tokens   INTEGER,
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


-- Inbound alerts and outbound integrations.

-- One row per alert-source card ('alertmanager', 'grafana', ...), each owning
-- its own inbound nwi_ credential: rotation affects one source, and
-- last_received_at makes per-source delivery status authoritative.
CREATE TABLE IF NOT EXISTS alert_sources (
  kind                TEXT   PRIMARY KEY,
  token_hash          TEXT   NOT NULL UNIQUE,
  token_encrypted     TEXT   NOT NULL,
  last_received_at    TEXT,
  created_at          TEXT   NOT NULL
);

-- One row per pull-integration, with per-kind JSON config and an encrypted
-- credential that is NULL when the kind has none. Neither is ever returned by
-- an endpoint. A new integration is a row, never a table.
CREATE TABLE IF NOT EXISTS integrations (
  kind                TEXT   PRIMARY KEY,
  config              TEXT   NOT NULL,
  secret_encrypted    TEXT,
  validated_at        TEXT   NOT NULL,
  created_at          TEXT   NOT NULL
);


-- Sessions and everything that belongs to one. Each child cascades with its
-- session (foreign_keys is enabled below), because none of it is reachable or
-- meaningful once the session is gone.

-- investigation is what the session IS, carried from the moment it exists, and
-- it is a one-way ratchet that never clears. alert_cleared_at is the other way
-- one resolves: the condition recovered, whoever fixed it.
CREATE TABLE IF NOT EXISTS sessions (
  session_id           TEXT      PRIMARY KEY,
  title                TEXT      NOT NULL DEFAULT '',
  originating_alert    TEXT,
  investigation        INTEGER   NOT NULL DEFAULT 0,
  alert_cleared_at     TEXT,
  created_at           TEXT      NOT NULL
);

-- The durable transcript, and the only record of what ran. canonical holds our
-- portable form of the turn plus the vendor's verbatim message, so a resume on
-- the same dialect replays byte-exact and a switched provider still reads it.
CREATE TABLE IF NOT EXISTS session_messages (
  id             INTEGER   PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT      NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  seq            INTEGER   NOT NULL,
  role           TEXT      NOT NULL,
  content        TEXT      NOT NULL,
  canonical      TEXT,
  created_at     TEXT      NOT NULL,
  UNIQUE (session_id, seq)
);

-- How a tool call ended, as the API classified it. Our own reading, which the
-- model never saw: parts above are rebuilt from the vendor's message and one
-- dialect carries no error flag at all, so it has nowhere to ride but here.
CREATE TABLE IF NOT EXISTS tool_outcomes (
  session_id     TEXT   NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_use_id    TEXT   NOT NULL,
  outcome        TEXT   NOT NULL,
  PRIMARY KEY (session_id, tool_use_id)
);

-- What a suspended run is waiting on. One per session: the loop gates on the
-- first write or question of a turn and stops there.
CREATE TABLE IF NOT EXISTS pending_human_input (
  session_id            TEXT   NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  tool_use_id           TEXT   NOT NULL,
  kind                  TEXT   NOT NULL DEFAULT 'approval',
  tool_name             TEXT   NOT NULL,
  tool_input            TEXT   NOT NULL,
  completed_results     TEXT   NOT NULL DEFAULT '[]',
  claimed_at            TEXT,
  created_at            TEXT   NOT NULL,
  PRIMARY KEY (session_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_human_input_claimed
  ON pending_human_input (claimed_at);

-- The investigation record, appended to one act at a time, and a child of its
-- session because a record nobody can reach is not a record. It holds only what
-- the model wrote; evidence, conviction and status are resolved on read.
CREATE TABLE IF NOT EXISTS reports (
  session_id     TEXT   PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  report         TEXT   NOT NULL,
  model          TEXT,
  updated_at     TEXT   NOT NULL
);


-- The audit log, which outlives the sessions it refers to.

-- Intentionally NOT a child of sessions: it is the durable record of what was
-- changed on the fleet and must survive a deleted session, so session_id is a
-- plain historical reference rather than a cascading foreign key.
CREATE TABLE IF NOT EXISTS remediation_actions (
  id                      INTEGER   PRIMARY KEY AUTOINCREMENT,
  tool_use_id             TEXT      NOT NULL,
  session_id              TEXT      NOT NULL,
  tool_name               TEXT      NOT NULL,
  service_identity_key    TEXT,
  status                  TEXT      NOT NULL,
  resolved_by             TEXT,
  input                   TEXT      NOT NULL,
  result                  TEXT,
  created_at              TEXT      NOT NULL,
  resolved_at             TEXT,
  -- Write-ahead idempotency: this is what refuses to re-execute an approved write
  -- after a crash. It must never be widened - a service that moved runners between
  -- the crash and the retry would then run twice, which is the exact case it exists for.
  UNIQUE (session_id, tool_use_id)
);

-- Covers the recent-action count the approval card shows, which filters on exactly
-- these columns; without it that read full-scans the audit history.
CREATE INDEX IF NOT EXISTS idx_remediation_recent
  ON remediation_actions (service_identity_key, tool_name, status, created_at);
`;

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!_db) {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
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
