import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

// D1: single SQLite source of record. Lazy open so tests can set NIGHTWATCH_DB_PATH before
// first query; exported so D16 self-provisioning can place the key file beside the database.
export function dbPath(): string {
  return process.env["NIGHTWATCH_DB_PATH"] ?? "/var/nightwatch/nightwatch.db";
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runner (
    id           TEXT PRIMARY KEY,
    token        TEXT NOT NULL UNIQUE,
    runner_id    TEXT,
    label        TEXT,
    server_name  TEXT UNIQUE,
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

  CREATE TABLE IF NOT EXISTS remediation_actions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_use_id          TEXT NOT NULL,
    session_id           TEXT NOT NULL REFERENCES sessions(session_id),
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

// Renames the legacy `tokens` table to `runner` if it still exists under the
// old name. Runs before the main schema so `CREATE TABLE IF NOT EXISTS runner`
// becomes a no-op once the rename completes. Safe on fresh DBs (no-op).
function renameTokensToRunner(db: Database.Database): void {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
  if (tables.includes("tokens") && !tables.includes("runner")) {
    db.prepare("ALTER TABLE tokens RENAME TO runner").run();
  }
}

// Rebuilds a table with a standalone tool_use_id UNIQUE constraint to the
// composite (session_id, tool_use_id) form. Detects via pragma — safe on fresh
// DBs where the new schema already applies.
function migrateCompositeUniqueKey(
  db: Database.Database,
  tableName: string,
  newDdl: string,
  extraStatements: string[],
): void {
  // better-sqlite3 types .all() as unknown[]; PRAGMA column shapes are stable
  // across the SQLite version bundled with Node.
  const indexList = db
    .prepare(`PRAGMA index_list('${tableName}')`)
    .all() as Array<{ name: string; unique: number }>;
  const hasOldConstraint = indexList.some((idx) => {
    if (!idx.unique) return false;
    // same reason as above — narrowing the per-column PRAGMA result
    const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all() as Array<{
      name: string;
    }>;
    return cols.length === 1 && cols[0]?.name === "tool_use_id";
  });
  if (!hasOldConstraint) return;

  db.transaction(() => {
    db.prepare(`DROP TABLE IF EXISTS ${tableName}_new`).run();
    db.prepare(newDdl).run();
    db.prepare(`INSERT INTO ${tableName}_new SELECT * FROM ${tableName}`).run();
    db.prepare(`DROP TABLE ${tableName}`).run();
    db.prepare(`ALTER TABLE ${tableName}_new RENAME TO ${tableName}`).run();
    for (const stmt of extraStatements) {
      db.prepare(stmt).run();
    }
  })();
}

// Migrates databases created before the config/user schema split. Detects the
// old owner columns in config, copies the data into user, then recreates config
// without them. Safe to call on fresh DBs (no-op when owner_email is absent).
function applyMigrations(db: Database.Database): void {
  const configCols = (
    db.prepare("PRAGMA table_info(config)").all() as Array<{ name: string }>
  ).map((c) => c.name);

  const runnerCols = (
    db.prepare("PRAGMA table_info(runner)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!runnerCols.includes("server_name")) {
    db.prepare("ALTER TABLE runner ADD COLUMN server_name TEXT").run();
    db.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_server_name ON runner(server_name) WHERE server_name IS NOT NULL",
    ).run();
  }

  const userCols = (
    db.prepare("PRAGMA table_info(user)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  if (!userCols.includes("ingest_token_encrypted")) {
    db.prepare("ALTER TABLE user ADD COLUMN ingest_token_encrypted TEXT").run();
  }

  migrateCompositeUniqueKey(
    db,
    "remediation_actions",
    `CREATE TABLE remediation_actions_new (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_use_id          TEXT NOT NULL,
      session_id           TEXT NOT NULL REFERENCES sessions(session_id),
      tool_name            TEXT NOT NULL,
      service_identity_key TEXT,
      status               TEXT NOT NULL,
      resolved_by          TEXT,
      input                TEXT NOT NULL,
      result               TEXT,
      created_at           TEXT NOT NULL,
      resolved_at          TEXT,
      UNIQUE (session_id, tool_use_id)
    )`,
    [],
  );

  migrateCompositeUniqueKey(
    db,
    "pending_human_input",
    `CREATE TABLE pending_human_input_new (
      session_id        TEXT NOT NULL REFERENCES sessions(session_id),
      tool_use_id       TEXT NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'approval',
      tool_name         TEXT NOT NULL,
      tool_input        TEXT NOT NULL,
      completed_results TEXT NOT NULL DEFAULT '[]',
      claimed_at        TEXT,
      created_at        TEXT NOT NULL,
      PRIMARY KEY (session_id)
    )`,
    [
      `CREATE INDEX IF NOT EXISTS idx_pending_human_input_claimed
       ON pending_human_input(claimed_at)`,
    ],
  );

  if (!configCols.includes("owner_email")) return;

  db.transaction(() => {
    const { c } = db.prepare("SELECT COUNT(*) AS c FROM user").get() as {
      c: number;
    };

    if (c === 0) {
      db.prepare(
        `INSERT OR IGNORE INTO user (id, email, hash, login_version, updated_at)
         SELECT 'global', owner_email, owner_hash,
                COALESCE(login_version, 0),
                COALESCE(updated_at, datetime('now'))
         FROM config
         WHERE id = 'global' AND owner_email IS NOT NULL`,
      ).run();
    }

    db.prepare("DROP TABLE IF EXISTS config_v2").run();

    db.prepare(
      `CREATE TABLE config_v2 (
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
        updated_at         TEXT NOT NULL
      )`,
    ).run();

    db.prepare(
      `INSERT INTO config_v2
       SELECT id, provider, model, thinking, max_output_tokens, max_retries,
              request_timeout_ms, max_tool_calls, hard_timeout_ms, tool_timeout_ms,
              remediation_breaker_limit, remediation_breaker_window_ms,
              base_url, api_key_encrypted, prompt_caching, reasoning_effort, updated_at
       FROM config`,
    ).run();

    db.prepare("DROP TABLE config").run();
    db.prepare("ALTER TABLE config_v2 RENAME TO config").run();
  })();
}

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!_db) {
    const path = dbPath();
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    renameTokensToRunner(db);
    db.exec(SCHEMA);
    applyMigrations(db);
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
