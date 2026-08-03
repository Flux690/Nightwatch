import { getSession } from "../../db/sessions.js";

// Evidence windows anchor on when the alert fired, never on when the tool ran -
// runs pause for approvals, so "now" drifts. The earliest of a batch, since that
// is when the incident began showing. Chat sessions have no alert: "now".
export function alertAnchorFor(sessionId: string): Date {
  const fired = (getSession(sessionId)?.alerts ?? [])
    .map((entry) => new Date(entry.alert.firedAt).getTime())
    .filter((ms) => !Number.isNaN(ms));
  return fired.length > 0 ? new Date(Math.min(...fired)) : new Date();
}
