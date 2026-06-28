import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";

// The runner keeps no database - the API is the system of record. Its only
// durable state is this id file in the data dir, so identity survives restarts
// (hostname+pid did not).
const DATA_DIR = process.env["NIGHTWATCH_DATA_DIR"] ?? "/var/nightwatch";
const ID_PATH = join(DATA_DIR, "runner-id");

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
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(ID_PATH, id, "utf8");
  logger.info({ runnerId: id, path: ID_PATH }, "generated runner id");
  cached = id;
  return id;
}
