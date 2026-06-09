import { Redis } from "ioredis";

function parseRedisUrl(url: string): {
  host: string;
  port: number;
  password?: string;
  db?: number;
} {
  try {
    const u = new URL(url);
    // The path segment (redis://host:port/15) selects the logical database.
    // Tests point at a dedicated db so they never share BullMQ queues or
    // keyspace with the dev server on the same instance.
    const dbSegment = u.pathname.replace(/^\//, "");
    const db = dbSegment ? parseInt(dbSegment, 10) : undefined;
    return {
      host: u.hostname || "localhost",
      port: parseInt(u.port || "6379", 10),
      password: u.password || undefined,
      db: Number.isNaN(db as number) ? undefined : db,
    };
  } catch {
    return { host: "localhost", port: 6379 };
  }
}

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

export const redis = new Redis(REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

// Plain connection opts for BullMQ (avoids ioredis version mismatch when passing an instance)
export const bullmqConnection = parseRedisUrl(REDIS_URL);
