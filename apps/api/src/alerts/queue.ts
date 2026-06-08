import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { redis, bullmqConnection } from "../redis/client.js";
import type { NormalizedAlert } from "@nightwatch/shared";
import type { RunInvestigationInput } from "../investigation/loop.js";

export const investigationQueue = new Queue("investigations", {
  connection: bullmqConnection,
});

const RATE_LIMIT_WINDOW_SECONDS = 3600;
const RATE_LIMIT_MAX = 10;
const DEBOUNCE_SECONDS = 90;

export async function checkRateLimit(
  token: string,
  severity: NormalizedAlert["severity"],
): Promise<boolean> {
  if (severity === "critical") return true;

  const key = `rate:${token}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW_SECONDS);

  return count <= RATE_LIMIT_MAX;
}

export async function tryDebounce(token: string): Promise<boolean> {
  const key = `debounce:${token}`;
  const result = await redis.set(key, "1", "EX", DEBOUNCE_SECONDS, "NX");
  return result !== null;
}

export async function enqueueInvestigation(
  alert: NormalizedAlert,
): Promise<void> {
  // The session id is minted here so the whole investigation - persistence and
  // the live pub/sub channel - is keyed by it from the first turn.
  const job: RunInvestigationInput = {
    alert,
    sessionId: randomUUID(),
    trigger: "alert",
  };
  await investigationQueue.add("investigate", job, {
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}
