import Redis from "ioredis";

function parseRedisUrl(url: string): {
  host: string;
  port: number;
  password?: string;
} {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || "localhost",
      port: parseInt(u.port || "6379", 10),
      password: u.password || undefined,
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
