import { dispatcher } from "../dispatcher.js";
import { hasPendingHumanInputForAlert } from "../db/interrupts.js";
import type { NormalizedAlert } from "@nightwatch/shared";

// Dedup is derived, never stored: an alert is a duplicate iff a run for the
// same (fingerprint, startsAt) is already active or durably suspended on
// approval. startsAt distinguishes twin incidents that share a fingerprint.
export function isDuplicate(alert: NormalizedAlert): boolean {
  return (
    dispatcher.isInvestigating(alert.sourceAlertId, alert.firedAt) ||
    hasPendingHumanInputForAlert(alert.sourceAlertId, alert.firedAt)
  );
}
