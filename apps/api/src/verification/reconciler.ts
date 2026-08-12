import { getSession, sessionIdsWithOpenAlerts } from "../db/sessions.js";
import { logger } from "../logger.js";
import { verifyRecovery } from "./recovery.js";

/* An alert clears when its condition stops being true, which is rarely the
   instant a run ends. A fix lands, the rule's `for:` duration elapses, and the
   alert goes quiet minutes later with nobody listening. This is the ear.

   The trigger is deliberately not tied to anything the agent did: a bash call
   may only have read, a pull request is not a fix until someone merges it, and
   a restart takes minutes to show. Nothing here tries to detect that a fix
   happened. It asks about every condition still open, less and less often. */

interface Step {
  // The oldest an alert can be for this step to apply.
  withinMs: number;
  everyMs: number;
}

const MINUTE = 60_000;

/* Dense while an incident is live, thin once it is clearly not resolving on its
   own, and stopped after a day: past that nobody is watching this run, and the
   webhook still answers instantly if the condition ever does clear. */
const SCHEDULE: readonly Step[] = [
  { withinMs: 15 * MINUTE, everyMs: MINUTE },
  { withinMs: 75 * MINUTE, everyMs: 5 * MINUTE },
  { withinMs: 24 * 60 * MINUTE, everyMs: 30 * MINUTE },
];

export const RECONCILE_TICK_MS = MINUTE;

/* When each session was last asked about. In memory on purpose: a restart costs
   one extra round of questions, which is the harmless direction, and the
   alternative is a column that exists only to describe a schedule. */
const lastAsked = new Map<string, number>();

/* How long we have been watching, which is what the backoff thins out. Anchored
   on the session rather than on the alert's own firedAt: an alert that has been
   firing for a month is a brand new incident to an install that just ingested
   it, and anchoring on firedAt would retire it before the first question. */
function watchingSince(sessionId: string): number {
  const created = getSession(sessionId)?.createdAt;
  return created === undefined ? Date.now() : new Date(created).getTime();
}

function due(sessionId: string, ageMs: number, now: number): boolean {
  const step = SCHEDULE.find((s) => ageMs < s.withinMs);
  if (step === undefined) return false;
  const last = lastAsked.get(sessionId);
  return last === undefined || now - last >= step.everyMs;
}

// Keeps the map the size of the work rather than the size of the history.
function forgetSettled(open: Set<string>): void {
  for (const sessionId of lastAsked.keys()) {
    if (!open.has(sessionId)) lastAsked.delete(sessionId);
  }
}

/* One pass. Sequential rather than parallel: these are the same few rules on
   one Prometheus, and a burst of concurrent requests to it mid-incident is the
   last thing an operator needs from us. */
export async function reconcileRecovery(
  now = Date.now(),
): Promise<{ asked: number; cleared: number }> {
  const result = { asked: 0, cleared: 0 };
  const sessionIds = sessionIdsWithOpenAlerts();
  forgetSettled(new Set(sessionIds));

  for (const sessionId of sessionIds) {
    if (!due(sessionId, now - watchingSince(sessionId), now)) continue;
    lastAsked.set(sessionId, now);
    result.asked++;
    try {
      if ((await verifyRecovery(sessionId)) === "confirmed") result.cleared++;
    } catch (err) {
      // One unreachable source must not stop the rest of the sweep.
      logger.warn({ err, sessionId }, "recovery reconciler: session skipped");
    }
  }
  return result;
}

// The schedule is process state, so a test driving several passes starts each
// from a clean one rather than inheriting the previous test's timings.
export function resetReconcilerSchedule(): void {
  lastAsked.clear();
}
