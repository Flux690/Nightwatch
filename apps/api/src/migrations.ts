/* Applied in order. A version is a fact about every install, so an entry is
   frozen from the first release; before it the baseline is edited directly. */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const BASELINE = `

CREATE TABLE IF NOT EXISTS runner (
  id             TEXT     PRIMARY KEY,
  token          TEXT     NOT NULL UNIQUE,
  platform       TEXT     NOT NULL CHECK (platform IN ('docker', 'kubernetes')),
  server_name    TEXT     NOT NULL UNIQUE,
  created_at     TEXT     NOT NULL,
  last_used_at   TEXT
);

CREATE TABLE IF NOT EXISTS config (
  id                            TEXT     PRIMARY KEY,
  active_provider               TEXT,
  max_retries                   INTEGER  NOT NULL DEFAULT 3,
  request_timeout_ms            INTEGER  NOT NULL DEFAULT 120000,
  max_concurrent_investigations INTEGER  NOT NULL DEFAULT 10,
  check_in_after_ms             INTEGER  NOT NULL DEFAULT 1800000,
  tool_call_ceiling_ms          INTEGER  NOT NULL DEFAULT 600000,
  sandbox_idle_timeout_ms       INTEGER  NOT NULL DEFAULT 3600000,
  sandbox_cpus                  INTEGER  NOT NULL DEFAULT 2,
  sandbox_memory_mb             INTEGER  NOT NULL DEFAULT 4096,
  sandbox_require_gvisor        INTEGER  NOT NULL DEFAULT 0,
  sandbox_network               TEXT     NOT NULL DEFAULT 'allowlist',
  sandbox_allowlist_hosts       TEXT     NOT NULL DEFAULT 'registry.npmjs.org
registry.yarnpkg.com
repo.yarnpkg.com',
  updated_at                    TEXT     NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_config (
  provider            TEXT     PRIMARY KEY,
  model               TEXT,
  base_url            TEXT,
  api_key_encrypted   TEXT,
  reasoning_level     TEXT,
  updated_at          TEXT     NOT NULL
);

CREATE TABLE IF NOT EXISTS integrations (
  id            TEXT   PRIMARY KEY,
  kind          TEXT   NOT NULL,
  name          TEXT   NOT NULL,
  config        TEXT   NOT NULL,
  secrets       TEXT,
  token_hash    TEXT   UNIQUE,
  validated_at  TEXT,
  last_used_at  TEXT,
  created_at    TEXT   NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_name ON integrations(name);
CREATE INDEX IF NOT EXISTS idx_integrations_kind ON integrations(kind);

CREATE TABLE IF NOT EXISTS sessions (
  session_id           TEXT     PRIMARY KEY,
  title                TEXT     NOT NULL DEFAULT '',
  investigation        INTEGER  NOT NULL DEFAULT 0,
  status               TEXT     NOT NULL DEFAULT 'completed'
                                CHECK (status IN ('action_required', 'running',
                                  'resolved', 'stopped', 'failed', 'completed')),
  failed_attempts      INTEGER  NOT NULL DEFAULT 0,
  failure_kind         TEXT     CHECK (failure_kind IN ('transient', 'permanent')),
  stopped_at           TEXT,
  awaiting_tool_use_id TEXT,
  awaiting_kind        TEXT     CHECK (awaiting_kind IN
                                  ('approval', 'clarification', 'continue')),
  awaiting_results     TEXT     NOT NULL DEFAULT '[]',
  attempt_started_at   TEXT,
  hypotheses           TEXT     NOT NULL DEFAULT '[]',
  report               TEXT,
  record_updated_at    TEXT,
  created_at           TEXT     NOT NULL,
  last_activity_at     TEXT     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_list
  ON sessions(investigation,
              (awaiting_tool_use_id IS NOT NULL) DESC,
              last_activity_at DESC,
              session_id ASC);
DROP INDEX IF EXISTS idx_sessions_kind_activity;

CREATE INDEX IF NOT EXISTS idx_sessions_seats ON sessions(investigation, status);

CREATE TABLE IF NOT EXISTS alerts (
  id                 INTEGER  PRIMARY KEY,
  session_id         TEXT     REFERENCES sessions(session_id) ON DELETE CASCADE,
  group_key          TEXT     NOT NULL,
  source_alert_id    TEXT     NOT NULL,
  labels             TEXT     NOT NULL DEFAULT '{}',
  alert_type         TEXT     NOT NULL DEFAULT 'unknown',
  fired_at           TEXT     NOT NULL,
  arrived_at         TEXT     NOT NULL,
  cleared_at         TEXT,
  injected           INTEGER  NOT NULL DEFAULT 0,
  dropped_alerts     INTEGER  NOT NULL DEFAULT 0,
  group_context      TEXT,
  alert              TEXT     NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_session ON alerts(session_id, id);
CREATE INDEX IF NOT EXISTS idx_alerts_source ON alerts(source_alert_id, fired_at);
CREATE INDEX IF NOT EXISTS idx_alerts_open
  ON alerts(session_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_queued
  ON alerts(arrived_at) WHERE session_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_group ON alerts(group_key);

CREATE TABLE IF NOT EXISTS session_transcript (
  session_id     TEXT     NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  seq            INTEGER  NOT NULL,
  kind           TEXT     NOT NULL,
  content        TEXT     NOT NULL,
  canonical      TEXT,
  timestamp      TEXT     NOT NULL,
  PRIMARY KEY (session_id, seq)
);


-- Better Auth's own four tables, shaped by what its getMigrations emits. It
-- writes dates as ISO strings and booleans as 0/1.

CREATE TABLE user (
  id             TEXT     NOT NULL PRIMARY KEY,
  name           TEXT     NOT NULL,
  email          TEXT     NOT NULL UNIQUE,
  email_verified INTEGER  NOT NULL,
  image          TEXT,
  created_at     DATE     NOT NULL,
  updated_at     DATE     NOT NULL,
  role           TEXT,
  banned         INTEGER,
  ban_reason     TEXT,
  ban_expires    DATE
);

CREATE TABLE auth_session (
  id              TEXT     NOT NULL PRIMARY KEY,
  expires_at      DATE     NOT NULL,
  token           TEXT     NOT NULL UNIQUE,
  created_at      DATE     NOT NULL,
  updated_at      DATE     NOT NULL,
  ip_address      TEXT,
  user_agent      TEXT,
  user_id         TEXT     NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  impersonated_by TEXT
);

CREATE TABLE account (
  id                          TEXT     NOT NULL PRIMARY KEY,
  issuer                      TEXT     NOT NULL,
  account_id                  TEXT     NOT NULL,
  provider_id                 TEXT     NOT NULL,
  user_id                     TEXT     NOT NULL REFERENCES user (id) ON DELETE CASCADE,
  access_token                TEXT,
  refresh_token               TEXT,
  id_token                    TEXT,
  access_token_expires_at     DATE,
  refresh_token_expires_at    DATE,
  scope                       TEXT,
  password                    TEXT,
  created_at                  DATE     NOT NULL,
  updated_at                  DATE     NOT NULL
);

CREATE TABLE verification (
  id         TEXT     NOT NULL PRIMARY KEY,
  identifier TEXT     NOT NULL,
  value      TEXT     NOT NULL,
  expires_at DATE     NOT NULL,
  created_at DATE     NOT NULL,
  updated_at DATE     NOT NULL
);

CREATE INDEX auth_session_user_id_idx ON auth_session (user_id);
CREATE INDEX account_user_id_idx ON account (user_id);
CREATE INDEX verification_identifier_idx ON verification (identifier);
CREATE UNIQUE INDEX account_issuer_account_id_uidx ON account (issuer, account_id);

`;

/* Transcribed from what Better Auth's own getMigrations emits for this config,
   so the columns are the library's answer rather than a reading of its docs. */

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "baseline", sql: BASELINE },
];
