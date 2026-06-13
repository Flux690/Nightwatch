import { dispatcher } from "../dispatch/dispatcher.js";
import type { NormalizedAlert } from "@nightwatch/shared";

// Dedup is derived, never stored (CONTEXT.md D2/D4): an alert is a duplicate iff
// a run for the same token + sourceAlertId is already active or queued. There is
// no dedup key and no TTL - a crashed run leaves no marker, so a re-fired alert
// correctly re-investigates instead of being suppressed for hours.
//
// A run parked on a human approval still counts: pre-022 the loop awaits the
// approval in memory, so its dispatch is still active. Issue 022 makes the wait
// durable and swaps this source to the pending_interrupts table.
export function isDuplicate(alert: NormalizedAlert): boolean {
  return dispatcher.isInvestigating(alert.token, alert.sourceAlertId);
}
