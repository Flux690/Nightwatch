import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { resetDb } from "../db/client.js";

// Points the API db at a throwaway SQLite file for the suite and returns a teardown. Call at
// the top of beforeAll before anything opens the (lazy) db; pair the teardown with
// vi.unstubAllEnvs() in afterAll.
export function useTempDb(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "nw-api-"));
  vi.stubEnv("NIGHTWATCH_DB_PATH", join(dir, "nightwatch.db"));
  return () => {
    resetDb();
    rmSync(dir, { recursive: true, force: true });
  };
}
