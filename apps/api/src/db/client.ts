import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { dbPath } from "../env/paths.js";

// No upgrade migrations: pre-production, so a schema change is applied by
// recreating the database, not by migrating data.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runner (
    id                TEXT PRIMARY KEY,
    token             TEXT NOT NULL UNIQUE,
    label             TEXT,
    server_name       TEXT UNIQUE,
    remediation_mode  INTEGER,
    created_at        TEXT NOT NULL,
    last_used_at      TEXT
  );

  -- Loop and sandbox policy, which is provider-independent. Anything that
  -- describes how to reach one model lives in provider_config below.
  CREATE TABLE IF NOT EXISTS config (
    id                 TEXT PRIMARY KEY,
    -- Which provider_config row is live. NULL means the operator has not picked
    -- yet, which the run gate refuses on; a default would make a fresh install
    -- look configured while holding no API key.
    active_provider    TEXT,
    max_output_tokens  INTEGER NOT NULL DEFAULT 32000,
    max_retries        INTEGER NOT NULL DEFAULT 2,
    request_timeout_ms INTEGER NOT NULL DEFAULT 120000,
    hard_timeout_ms    INTEGER NOT NULL DEFAULT 300000,
    tool_timeout_ms    INTEGER NOT NULL DEFAULT 15000,
    remediation_breaker_limit     INTEGER NOT NULL DEFAULT 5,
    remediation_breaker_window_ms INTEGER NOT NULL DEFAULT 600000,
    code_session_budget_ms  INTEGER NOT NULL DEFAULT 1200000,
    sandbox_idle_timeout_ms INTEGER NOT NULL DEFAULT 3600000,
    sandbox_cpus            INTEGER NOT NULL DEFAULT 2,
    sandbox_memory_mb       INTEGER NOT NULL DEFAULT 4096,
    sandbox_require_gvisor  INTEGER NOT NULL DEFAULT 0,
    sandbox_network         TEXT NOT NULL DEFAULT 'allowlist',
    sandbox_allowlist_hosts TEXT NOT NULL DEFAULT 'registry.npmjs.org
registry.yarnpkg.com
repo.yarnpkg.com',
    updated_at         TEXT NOT NULL
  );

  -- One row per provider, each owning its own credentials and endpoint, so
  -- switching the active provider cannot carry the previous one's key or base
  -- URL across. thinking is Anthropic's knob, reasoning_effort OpenAI's.
  CREATE TABLE IF NOT EXISTS provider_config (
    provider          TEXT PRIMARY KEY,
    model             TEXT,
    base_url          TEXT,
    api_key_encrypted TEXT,
    thinking          TEXT NOT NULL DEFAULT 'adaptive',
    reasoning_effort  TEXT,
    updated_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user (
    id                TEXT PRIMARY KEY,
    email             TEXT,
    hash              TEXT,
    login_version     INTEGER NOT NULL DEFAULT 0,
    updated_at        TEXT NOT NULL
  );

  -- One row per alert-source card ('alertmanager', 'grafana', ...), each owning
  -- its own inbound nwi_ credential: rotation affects one source, and
  -- last_received_at makes per-source delivery status authoritative.
  CREATE TABLE IF NOT EXISTS alert_sources (
    kind             TEXT PRIMARY KEY,
    token_hash       TEXT NOT NULL UNIQUE,
    token_encrypted  TEXT NOT NULL,
    last_received_at TEXT,
    created_at       TEXT NOT NULL
  );

  -- mode is what the session IS, recorded when it starts. Deriving it from the
  -- artifacts a run happens to produce reclassifies anything stopped early.
  CREATE TABLE IF NOT EXISTS sessions (
    session_id        TEXT PRIMARY KEY,
    title             TEXT NOT NULL DEFAULT '',
    originating_alert TEXT,
    mode              TEXT NOT NULL DEFAULT 'ask',
    created_at        TEXT NOT NULL
  );

  -- A session's transcript and any pending approval ARE part of the session, so
  -- they cascade-delete with it (foreign_keys is enabled below).
  -- canonical holds { parts, native }: our own portable form of the turn plus the
  -- vendor's verbatim message, so a same-dialect resume replays byte-exact and a
  -- switched provider still reads the conversation.
  CREATE TABLE IF NOT EXISTS session_messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    seq              INTEGER NOT NULL,
    role             TEXT NOT NULL,
    content          TEXT NOT NULL,
    canonical        TEXT,
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

  -- The investigation report, maintained live by the agent during an Investigate
  -- run. Like remediation_actions it is NOT a child of sessions: it is the durable
  -- record of the conclusion and must outlive a deleted session, so session_id is a
  -- plain reference. One row per session (full-replace on every UpdateReport).
  CREATE TABLE IF NOT EXISTS reports (
    session_id  TEXT PRIMARY KEY,
    report      TEXT NOT NULL,
    model       TEXT,
    updated_at  TEXT NOT NULL
  );

  -- One row per pull-integration ('github', 'prometheus', 'loki', ...): config is
  -- per-kind JSON, secret_encrypted is the encrypted credential (NULL when the
  -- kind has none, e.g. an auth-less Prometheus). Neither is ever returned by an
  -- endpoint. A new integration is a row, never a table; config is validated
  -- per-kind in app code since rows are only ever read whole by kind.
  CREATE TABLE IF NOT EXISTS integrations (
    kind             TEXT PRIMARY KEY,
    config           TEXT NOT NULL,
    secret_encrypted TEXT,
    validated_at     TEXT NOT NULL,
    created_at       TEXT NOT NULL
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
