import type { SessionAlert } from "@nightwarden/shared";
import { getSession, markAlertCleared } from "../db/sessions.js";
import { logger } from "../logger.js";
import { publishReportUpdated } from "../session/stream.js";
import type { VerificationSource } from "./source.js";
import { prometheusSource } from "./sources/prometheus.js";

/* Every source that can answer whether a condition is still true. A static list
   for the same reason the tool registry is one: what the system can do is
   decided at build time, not discovered at runtime. */
const SOURCES: readonly VerificationSource[] = [prometheusSource];

type RecoveryState =
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

/* Stamps `clearedAt`, the field Alertmanager's resolved webhook also writes, so
   status derivation stays a synchronous read and never learns to make an HTTP
   call. Called when a run tries to end, never on the read path. */
export async function verifyRecovery(
  sessionId: string,
): Promise<RecoveryState> {
  const alerts = getSession(sessionId)?.alerts ?? [];
  if (alerts.length === 0) return "no_condition";

  const open = uncleared(alerts);
  if (open.length === 0) return "confirmed";

  let clearedAny = false;
  for (const entry of open) {
    const source = SOURCES.find((s) => s.claims(entry.alert));
    if (source === undefined) continue;
    if ((await source.checkCondition(entry.alert)) === "unknown") continue;
    logger.info(
      { sessionId, source: source.name, alertType: entry.alert.alertType },
      "verification: condition is no longer true",
    );
    markAlertCleared(entry.alert.sourceAlertId, new Date().toISOString());
    clearedAny = true;
  }
  if (clearedAny) publishReportUpdated(sessionId);

  // Re-read rather than reasoning about what was just written: a second alert
  // may have arrived while the sources were being asked.
  const stillOpen = uncleared(getSession(sessionId)?.alerts ?? []);
  return stillOpen.length === 0 ? "confirmed" : "unconfirmed";
}
