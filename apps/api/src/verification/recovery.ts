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
  // At least one condition is still true. A fix ran or it did not; either way
  // the incident is not over.
  | "still_firing"
  // Nothing could answer: no source claims the alert, or the one that does could
  // not be reached. Deliberately not "confirmed" - an unanswerable question is
  // not a yes.
  | "unconfirmed"
  // No alert opened this session, so there is no condition to recover. Nothing
  // to verify and nothing to claim.
  | "no_condition";

function uncleared(alerts: SessionAlert[]): SessionAlert[] {
  return alerts.filter((entry) => entry.clearedAt === null);
}

/* Asks whoever owns each still-open alert whether it is still firing, and stamps
   the ones that are not.

   It writes `clearedAt`, which is the same field Alertmanager's resolved webhook
   writes, on purpose: two independent ways of learning the same fact converge on
   one record, so status derivation stays a synchronous read of the session and
   never learns to make an HTTP call. That matters - it is read once per row of
   the investigations list.

   Called when a run tries to end, which is when the answer changes what happens
   next. Not on the read path. */
export async function verifyRecovery(
  sessionId: string,
): Promise<RecoveryState> {
  const alerts = getSession(sessionId)?.alerts ?? [];
  if (alerts.length === 0) return "no_condition";

  const open = uncleared(alerts);
  if (open.length === 0) return "confirmed";

  let anyAnswered = false;
  let clearedAny = false;
  for (const entry of open) {
    const source = SOURCES.find((s) => s.claims(entry.alert));
    if (source === undefined) continue;
    const firing = await source.stillFiring(entry.alert);
    if (firing === null) continue;
    anyAnswered = true;
    if (firing) continue;
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
  if (stillOpen.length === 0) return "confirmed";
  return anyAnswered ? "still_firing" : "unconfirmed";
}
