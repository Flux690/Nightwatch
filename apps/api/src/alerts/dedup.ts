import { dispatcher } from "../dispatcher.js";
import { hasPendingHumanInputForAlert } from "../db/interrupts.js";
import type { NormalizedAlert } from "@nightwatch/shared";

// Dedup is derived, never stored (D2/D4): an alert is a duplicate iff a run for the same
// runnerId+sourceAlertId is already active or durably suspended on approval. Keyed by
// runnerId; no TTLs.
export function isDuplicate(alert: NormalizedAlert): boolean {
  return (
    dispatcher.isInvestigating(alert.runnerId, alert.sourceAlertId) ||
    hasPendingHumanInputForAlert(alert.runnerId, alert.sourceAlertId)
  );
}
