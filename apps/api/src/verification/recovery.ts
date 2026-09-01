import type { SessionAlert } from "@nightwarden/shared";
import { markAlertCleared } from "../session/alerts-store.js";
import { getSession } from "../session/store.js";
import { logger } from "../logger.js";
import { publishReportUpdated } from "../session/stream.js";
import type { ConditionState, VerificationSource } from "./source.js";
import { metricsRulesSource } from "./sources/metrics-rules.js";

// A static list for the same reason the tool registry is one: what the system
// can do is decided at build time, never discovered at runtime.
const SOURCES: readonly VerificationSource[] = [metricsRulesSource];

export type RecoveryState =
  // Every alert that opened this investigation has cleared. The only state that
  // may be called resolved.
  | "confirmed"
  // Nothing confirms recovery: still firing, unreachable, or no source claims
  // the alert. An unanswerable question is not a yes.
  | "unconfirmed"
  // No alert opened this session, so there is no condition to recover.
  | "no_condition";

function uncleared(alerts: SessionAlert[]): SessionAlert[] {
  return alerts.filter((entry) => entry.clearedAt === null);
}

// The webhook and the reconciler both stamp clearedAt, so the finish gate
// reads the answer instead of making an HTTP call as a run ends.
export async function recoveryState(sessionId: string): Promise<RecoveryState> {
  const alerts = (await getSession(sessionId))?.alerts ?? [];
  if (alerts.length === 0) return "no_condition";
  return uncleared(alerts).length === 0 ? "confirmed" : "unconfirmed";
}

// One sweep's answers, keyed by the firing asked about. Several sessions opened
// on one alert otherwise send the rules API the same question several times.
export type ConditionCache = Map<string, ConditionState>;

function conditionKey(alert: SessionAlert["alert"]): string {
  return `${alert.sourceAlertId}\u0000${alert.firedAt}`;
}

// Stamps the same `clearedAt` the resolved webhook writes, so status stays a
// synchronous read. Called when a run tries to end, never on the read path.
export async function verifyRecovery(
  sessionId: string,
  cache?: ConditionCache,
): Promise<RecoveryState> {
  const alerts = (await getSession(sessionId))?.alerts ?? [];
  if (alerts.length === 0) return "no_condition";

  const open = uncleared(alerts);
  if (open.length === 0) return "confirmed";

  let clearedAny = false;
  for (const entry of open) {
    // Sequential rather than Array.find: an async predicate returns a promise,
    // which is always truthy, so the first source would always win.
    let source: (typeof SOURCES)[number] | undefined;
    for (const candidate of SOURCES) {
      if (await candidate.claims(entry.alert)) {
        source = candidate;
        break;
      }
    }
    if (source === undefined) continue;
    const key = conditionKey(entry.alert);
    let state = cache?.get(key);
    if (state === undefined) {
      state = await source.checkCondition(entry.alert);
      cache?.set(key, state);
    }
    if (state === "unknown") continue;
    logger.info(
      { sessionId, source: source.name, alertType: entry.alert.alertType },
      "verification: condition is no longer true",
    );
    await markAlertCleared(
      entry.alert.sourceAlertId,
      entry.alert.firedAt,
      new Date().toISOString(),
    );
    clearedAny = true;
  }
  if (clearedAny) publishReportUpdated(sessionId);

  // Re-read rather than reasoning about what was just written: a second alert
  // may have arrived while the sources were being asked.
  const stillOpen = uncleared((await getSession(sessionId))?.alerts ?? []);
  return stillOpen.length === 0 ? "confirmed" : "unconfirmed";
}
