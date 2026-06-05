import { redis } from "../redis/client.js";
import type { NormalizedAlert } from "@nightwatch/shared";

// 24h TTL — covers Alertmanager's default 4h repeat interval
const DEDUP_TTL_SECONDS = 86_400;

export async function isDuplicate(alert: NormalizedAlert): Promise<boolean> {
  const key = `dedup:${alert.token}:${alert.sourceAlertId}`;
  // NX = only set if not exists; null return means key already existed
  const result = await redis.set(key, "1", "EX", DEDUP_TTL_SECONDS, "NX");
  return result === null;
}
