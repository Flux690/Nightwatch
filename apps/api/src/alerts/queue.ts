import { Queue } from "bullmq";
import { redis, bullmqConnection } from "../redis/client.js";
import type { NormalizedAlert } from "@nightwatch/shared";

export const investigationQueue = new Queue("investigations", {
  connection: bullmqConnection,
});

const RATE_LIMIT_WINDOW_SECONDS = 3600;
const RATE_LIMIT_MAX = 10;
const DEBOUNCE_SECONDS = 90;

export async function checkRateLimit(
  installationId: string,
  severity: NormalizedAlert["severity"],
): Promise<boolean> {
  if (severity === "critical") return true;

  const key = `rate:${installationId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);

  return count <= RATE_LIMIT_MAX;
}

export async function tryDebounce(installationId: string): Promise<boolean> {
  const key = `debounce:${installationId}`;
  const result = await redis.set(key, "1", "EX", DEBOUNCE_SECONDS, "NX");
  return result !== null;
}

export async function enqueueInvestigation(
  alert: NormalizedAlert,
): Promise<void> {
  await investigationQueue.add("investigate", alert, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}
