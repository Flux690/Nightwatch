import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { resetDb } from "../db/client.js";

// Points the API db at a throwaway SQLite file for the calling suite and returns
// a teardown. Call at the very top of beforeAll, before anything opens the db
// (the connection is lazy), so each suite gets isolated storage with no Postgres
// or shared state. Pair the returned teardown with vi.unstubAllEnvs() in afterAll.
export function useTempDb(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "nw-api-"));
  vi.stubEnv("NIGHTWATCH_DB_PATH", join(dir, "nightwatch.db"));
  return () => {
    resetDb();
    rmSync(dir, { recursive: true, force: true });
  };
}
