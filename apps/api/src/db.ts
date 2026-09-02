import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { MIGRATIONS } from "./migrations.js";
import { dbPath } from "./paths.js";
import type { Database as Schema } from "./schema.js";

export type Db = Kysely<Schema>;

/* Applied against the raw handle so a migration is one synchronous transaction.
   SQLite has transactional DDL, so a failure leaves nothing half-applied. */
function migrate(handle: Database.Database): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER  PRIMARY KEY,
      name       TEXT     NOT NULL,
      applied_at TEXT     NOT NULL
    );
  `);
  const rows = handle
    .prepare(`SELECT version FROM schema_migrations`)
    .all() as Array<{ version: number }>;
  const applied = new Set(rows.map((r) => r.version));

  let previous = 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= previous) {
      throw new Error(
        `migrations must ascend and each version appear once: ${migration.version} follows ${previous}`,
      );
    }
    previous = migration.version;
    if (applied.has(migration.version)) continue;

    handle.exec("BEGIN IMMEDIATE");
    try {
      handle.exec(migration.sql);
      handle
        .prepare(
          `INSERT INTO schema_migrations (version, name, applied_at)
           VALUES (?, ?, ?)`,
        )
        .run(migration.version, migration.name, new Date().toISOString());
      handle.exec("COMMIT");
    } catch (err) {
      handle.exec("ROLLBACK");
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `migration ${migration.version} (${migration.name}) failed: ${reason}`,
      );
    }
  }
}

let _handle: Database.Database | undefined;
let _db: Db | undefined;

// Migrations run at open rather than only at boot, because a test reaches the
// database through getDb and would otherwise be handed one with no tables.
export function getDb(): Db {
  if (!_db) {
    const path = dbPath();
    mkdirSync(dirname(path), { recursive: true });
    const handle = new Database(path);
    handle.pragma("journal_mode = WAL");
    // Off by default in SQLite, so ON DELETE CASCADE fires only once it is on.
    handle.pragma("foreign_keys = ON");
    migrate(handle);
    _handle = handle;
    _db = new Kysely<Schema>({
      dialect: new SqliteDialect({ database: handle }),
    });
  }
  return _db;
}

// Eager, so a misconfigured data path or a broken migration fails at boot
// rather than at 3am.
export function initDb(): void {
  getDb();
}

// The open database, or nothing. For a caller that must not be the one to
// create it: getDb() opens one, which is a side effect an assertion cannot have.
export function openDb(): Db | undefined {
  return _db;
}

export function resetDb(): void {
  _handle?.close();
  _handle = undefined;
  _db = undefined;
}
