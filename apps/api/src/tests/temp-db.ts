import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { resetDb } from "../db/client.js";

// Call at the top of beforeAll before anything opens the lazy db; pair the
// teardown with vi.unstubAllEnvs().
export function useTempDb(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "nw-api-"));
  vi.stubEnv("NIGHTWATCH_DIR", dir);
  return () => {
    resetDb();
    rmSync(dir, { recursive: true, force: true });
  };
}
