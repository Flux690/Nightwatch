import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";

const DB_PATH =
  process.env["NIGHTWATCH_DB_PATH"] ?? "/var/nightwatch/history.db";

// Identity lives beside the SQLite history in the persistent volume so it
// survives process restarts - hostname+pid did not (PLAN Phase 5).
const ID_PATH = join(dirname(DB_PATH), "runner-id");

let cached: string | undefined;

export function getRunnerId(): string {
  if (cached) return cached;

  if (existsSync(ID_PATH)) {
    const existing = readFileSync(ID_PATH, "utf8").trim();
    if (existing) {
      cached = existing;
      return existing;
    }
  }

  const id = `runner_${randomUUID()}`;
  mkdirSync(dirname(ID_PATH), { recursive: true });
  writeFileSync(ID_PATH, id, "utf8");
  logger.info({ runnerId: id, path: ID_PATH }, "generated runner id");
  cached = id;
  return id;
}
