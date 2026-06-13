import type { NormalizedAlert } from "@nightwatch/shared";

// Per-token alert rate limit, in memory (CONTEXT.md D2 - no Redis). A single
// Node process owns the whole deployment, so a shared counter store solves a
// problem we do not have. Critical severity always bypasses: a page at 3am must
// never be dropped because an earlier storm spent the budget.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 10;

interface Counter {
  count: number;
  resetAt: number;
}

const counters = new Map<string, Counter>();

export function checkRateLimit(
  token: string,
  severity: NormalizedAlert["severity"],
): boolean {
  if (severity === "critical") return true;

  const now = Date.now();
  const existing = counters.get(token);
  if (!existing || now >= existing.resetAt) {
    counters.set(token, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }

  existing.count++;
  return existing.count <= MAX_PER_WINDOW;
}
