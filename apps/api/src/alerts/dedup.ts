import { dispatcher } from "../dispatch/dispatcher.js";
import { hasPendingInterruptForAlert } from "../db/interrupts.js";
import type { NormalizedAlert } from "@nightwatch/shared";

// Dedup is derived, never stored (CONTEXT.md D2/D4): an alert is a duplicate iff
// a run for the same token + sourceAlertId is already active/queued OR the run
// is durably suspended waiting on human approval. No keys, no TTLs.
export function isDuplicate(alert: NormalizedAlert): boolean {
  return (
    dispatcher.isInvestigating(alert.token, alert.sourceAlertId) ||
    hasPendingInterruptForAlert(alert.token, alert.sourceAlertId)
  );
}
