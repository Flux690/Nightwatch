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
-- it is a one-way ratchet that never clears.

-- report is the investigation record, null until the agent's first finding, and
-- one-to-one with the session it cannot outlive.
-- last_activity_at is denormalised from the transcript's newest row, because the
-- list sorts on it: derived, it is a correlated subquery the sort has to run for
-- every session in the table before it can apply a LIMIT.

-- is_running is claimed by a conditional UPDATE, so it is the mutex as well as
-- the flag. There is one process, which is why it needs no TTL and no heartbeat:
-- anything still set at boot was killed, because this process just started.
CREATE TABLE IF NOT EXISTS sessions (
  session_id           TEXT      PRIMARY KEY,
  title                TEXT      NOT NULL DEFAULT '',
  investigation        INTEGER   NOT NULL DEFAULT 0,
  is_running           INTEGER   NOT NULL DEFAULT 0,
  report               TEXT,
  created_at           TEXT      NOT NULL,
  last_activity_at     TEXT      NOT NULL
);
-- Serves both the queue's filtered sort and its total, which are the two
-- queries a page load actually runs.
CREATE INDEX IF NOT EXISTS idx_sessions_kind_activity
  ON sessions(investigation, last_activity_at DESC);

-- One row per alert this session covers, in arrival order, each carrying when it
-- joined and when it cleared. A batch elects no primary, so recovery is a fact
-- about each alert and the session resolves only once they have all cleared.

-- The scalars are what anything looks an alert up BY: source_alert_id and
-- fired_at identify it, cleared_at says whether it is still open. Everything
-- else is read whole and never queried, so it stays JSON in the alert column.
CREATE TABLE IF NOT EXISTS session_alerts (
  id                 INTEGER   PRIMARY KEY,
  session_id         TEXT      NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  source_alert_id    TEXT      NOT NULL,
  fired_at           TEXT      NOT NULL,
  arrived_at         TEXT      NOT NULL,
  cleared_at         TEXT,
  alert              TEXT      NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_alerts_session
  ON session_alerts(session_id, id);
CREATE INDEX IF NOT EXISTS idx_session_alerts_source
  ON session_alerts(source_alert_id, fired_at);
-- Partial on purpose: the reconciler asks "what is still open" on a timer for
-- the life of the install, and cleared alerts only ever accumulate.
CREATE INDEX IF NOT EXISTS idx_session_alerts_open
  ON session_alerts(session_id) WHERE cleared_at IS NULL;

-- The durable transcript, and the only record of what ran, keyed by the natural
-- (session_id, seq). kind because not every row is a conversation turn: an error
-- row is our own note, a nightwarden row is the harness talking to the model.

-- canonical holds our portable form of the turn plus the vendor's verbatim
-- message, so a resume on the same dialect replays byte-exact and a switched
-- provider still reads it.
CREATE TABLE IF NOT EXISTS session_transcript (
  session_id     TEXT      NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  seq            INTEGER   NOT NULL,
  kind           TEXT      NOT NULL,
  content        TEXT      NOT NULL,
  canonical      TEXT,
  timestamp      TEXT      NOT NULL,
  PRIMARY KEY (session_id, seq)
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
-- first write or question of a turn and stops there. tool_use_id points at the
-- gated call, which the transcript holds under that same id.

-- completed_results are the turn's other calls, parked here because a transcript
-- answering some of a turn's calls and not others is a conversation that cannot
-- be replayed. They go back the moment the gated call is answered too.
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
    // Enforce the declared foreign keys (off by default in SQLite); this is what
    // makes ON DELETE CASCADE fire and forbids orphan rows.
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA);
    _db = db;
  }
  return _db;
}

// Open eagerly at boot so a misconfigured data path fails fast rather than on
// the first request.
//
// A claim is deliberately NOT cleared here. A row still claimed after a restart
// means the API died between approving a write and recording its result, so
// whether it ran is unknown - and clearing the claim would offer the operator a
// button that runs it a second time. It stays claimed and the respond route
// refuses it, which is the honest answer to a question nobody can answer.
export function initDb(): void {
  getDb();
}

export function resetDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
