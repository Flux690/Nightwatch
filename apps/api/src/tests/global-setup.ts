import { Redis } from "ioredis";
import { TEST_REDIS_URL } from "./test-redis.js";

// Flush the dedicated test database before the suite so leftover BullMQ job
// hashes from a previous run can't bleed into a fresh run. Guarded so it can
// never wipe the dev/prod database (db 0).
export default async function setup(): Promise<void> {
  const url = new URL(TEST_REDIS_URL);
  const db = parseInt(url.pathname.replace(/^\//, ""), 10);
  if (!Number.isInteger(db) || db === 0) {
    throw new Error(
      `Refusing to flush Redis: test db must be a non-zero index, got "${url.pathname}"`,
    );
  }

  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }
}
