const WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

interface Counter {
  count: number;
  resetAt: number;
}

export function createCredentialRateLimiter(): (ip: string) => boolean {
  const counters = new Map<string, Counter>();

  return function check(ip: string): boolean {
    const now = Date.now();
    const existing = counters.get(ip);
    if (!existing || now >= existing.resetAt) {
      counters.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    existing.count++;
    return existing.count <= MAX_ATTEMPTS;
  };
}
