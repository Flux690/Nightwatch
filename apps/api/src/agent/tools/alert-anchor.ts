import { getSession } from "../../db/sessions.js";

// Evidence windows anchor on when the alert fired, never on when the tool ran -
// runs pause for approvals, so "now" drifts. Chat sessions have no alert: "now".
export function alertAnchorFor(sessionId: string): Date {
  const firedAt = getSession(sessionId)?.originatingAlert?.firedAt;
  if (firedAt !== undefined) {
    const parsed = new Date(firedAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}
