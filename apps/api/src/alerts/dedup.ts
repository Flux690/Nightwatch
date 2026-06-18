import { dispatcher } from "../dispatch/dispatcher.js";
import { hasPendingHumanInputForAlert } from "../db/interrupts.js";
import type { NormalizedAlert } from "@nightwatch/shared";

// Dedup is derived, never stored (CONTEXT.md D2/D4): an alert is a duplicate iff
// a run for the same tokenId + sourceAlertId is already active OR the run is
// durably suspended waiting on human approval. Keyed by token (tokenId) — the
// stable per-server identity. No keys, no TTLs.
export function isDuplicate(alert: NormalizedAlert): boolean {
  return (
    dispatcher.isInvestigating(alert.runnerId, alert.sourceAlertId) ||
    hasPendingHumanInputForAlert(alert.runnerId, alert.sourceAlertId)
  );
}
