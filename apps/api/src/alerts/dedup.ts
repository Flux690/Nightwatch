import { isAlertCovered } from "../session/alerts-store.js";
import type { NormalizedAlert } from "@nightwarden/shared";

// Scoped to the alert, not the run: Alertmanager repeats a firing alert, so a
// run-scoped rule would reopen it every few minutes.
export function isDuplicate(alert: NormalizedAlert): boolean {
  return isAlertCovered(alert.sourceAlertId, alert.firedAt);
}
