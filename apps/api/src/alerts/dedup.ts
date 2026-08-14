import { isAlertCovered } from "../db/sessions.js";
import type { NormalizedAlert } from "@nightwarden/shared";

/* Derived: a duplicate iff some row holds this (fingerprint, startsAt) and
   nothing has said it recovered. Scoped to the alert, not the run - Alertmanager
   repeats a firing alert, so a run-scoped rule reopens it every few minutes. */
export function isDuplicate(alert: NormalizedAlert): boolean {
  return isAlertCovered(alert.sourceAlertId, alert.firedAt);
}
