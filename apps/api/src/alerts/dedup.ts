import { isAlertCovered } from "../session/alerts-store.js";
import type { NormalizedAlert } from "@nightwarden/shared";

// Scoped to the alert, not the run: Alertmanager repeats a firing alert, so a
// run-scoped rule would reopen it every few minutes.
export async function isDuplicate(alert: NormalizedAlert): Promise<boolean> {
  return await isAlertCovered(alert.sourceAlertId, alert.firedAt);
}
