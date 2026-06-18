import type { NormalizedAlert } from "@nightwatch/shared";

// Per-server alert rate limit, in memory (CONTEXT.md D2 - no Redis). Keyed by
// tokenId so each server has an independent budget. Critical severity always
// bypasses: a page at 3am must never be dropped.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 10;

interface Counter {
  count: number;
  resetAt: number;
}

const counters = new Map<string, Counter>();

export function checkRateLimit(
  runnerId: string,
  severity: NormalizedAlert["severity"],
): boolean {
  if (severity === "critical") return true;

  const now = Date.now();
  const existing = counters.get(runnerId);
  if (!existing || now >= existing.resetAt) {
    counters.set(runnerId, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  existing.count++;
  return existing.count <= MAX_PER_WINDOW;
}
