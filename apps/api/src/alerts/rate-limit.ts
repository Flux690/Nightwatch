// Fleet-wide investigation budget, in memory (no Redis). A run is what costs,
// not an alert: a storm batches into one, and later arrivals join it.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;

interface Counter {
  count: number;
  resetAt: number;
}

let counter: Counter | null = null;

// No severity bypass: exempting the literal word "critical" exempts one guess
// at the operator's vocabulary and budgets a "P1" emergency as routine.
export function checkInvestigationBudget(): boolean {
  const now = Date.now();
  if (!counter || now >= counter.resetAt) {
    counter = { count: 1, resetAt: now + WINDOW_MS };
    return true;
  }

  counter.count++;
  return counter.count <= MAX_PER_WINDOW;
}
