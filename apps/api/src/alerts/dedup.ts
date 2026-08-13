import { isAlertCovered } from "../db/sessions.js";
import type { NormalizedAlert } from "@nightwarden/shared";

/* Derived, never stored: an alert is a duplicate iff some row already holds this
   (fingerprint, startsAt) and nothing has said the condition recovered.

   Scoped to the alert rather than to the run that investigated it, because
   Alertmanager repeats a still-firing alert on repeat_interval - as often as
   every few minutes. Keyed on the run, a repeat would open a fresh investigation
   of the identical alert every time the previous one finished. */
export function isDuplicate(alert: NormalizedAlert): boolean {
  return isAlertCovered(alert.sourceAlertId, alert.firedAt);
}
