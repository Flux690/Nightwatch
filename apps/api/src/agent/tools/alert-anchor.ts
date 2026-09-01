import { getSession } from "../../session/store.js";

// Anchored on when the alert fired, never when the tool ran: runs pause for
// approvals, so "now" drifts. The earliest of a batch; a chat gets "now".
export async function alertAnchorFor(sessionId: string): Promise<Date> {
  const fired = ((await getSession(sessionId))?.alerts ?? [])
    .map((entry) => new Date(entry.alert.firedAt).getTime())
    .filter((ms) => !Number.isNaN(ms));
  return fired.length > 0 ? new Date(Math.min(...fired)) : new Date();
}
