import type { NormalizedAlert } from "@nightwarden/shared";

// Fleet-wide alert budget, in memory (no Redis): one global counter is the storm cap since
// every non-critical alert now reaches an LLM session. Critical severity always bypasses.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;

interface Counter {
  count: number;
  resetAt: number;
}

let counter: Counter | null = null;

export function checkRateLimit(severity: NormalizedAlert["severity"]): boolean {
  if (severity === "critical") return true;

  const now = Date.now();
  if (!counter || now >= counter.resetAt) {
    counter = { count: 1, resetAt: now + WINDOW_MS };
    return true;
  }

  counter.count++;
  return counter.count <= MAX_PER_WINDOW;
}
