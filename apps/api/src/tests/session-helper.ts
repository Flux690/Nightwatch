import { randomUUID } from "node:crypto";
import type { NormalizedAlert, SessionMeta } from "@nightwarden/shared";
import { mintSession } from "../auth/session.js";
import { buildSessionMeta } from "../agent/loop.js";
import { dispatcher } from "../dispatcher.js";
import {
  createSession,
  enqueueAlerts,
  openSessionForGroup,
} from "../db/sessions.js";

/* Seeds an alert-opened session by the only route production has: the alerts are
   queued under a group key, then a session takes them. Bypassing that with a
   direct insert would build a session whose alerts never passed through the
   queue, which is a shape ingest cannot produce. */
export function seedAlertSession(
  meta: SessionMeta,
  alerts: NormalizedAlert[],
  groupKey = `test-group-${randomUUID()}`,
): void {
  if (alerts.length === 0) {
    createSession(meta, true);
    return;
  }
  enqueueAlerts(groupKey, alerts);
  openSessionForGroup(meta, groupKey);
}

/* Opens an alert investigation the way promotion does: the row and its alerts
   exist before anything dispatches into it. dispatch() refuses a session nothing
   has written, so a test that skips this is testing a shape ingest cannot reach. */
export function dispatchAlertSession(
  sessionId: string,
  alerts: NormalizedAlert[],
  groupKey = `test-group-${randomUUID()}`,
): boolean {
  // Queued first, then the session takes them - the order promotion uses, and
  // what makes an opening alert predate the session it opened.
  enqueueAlerts(groupKey, alerts);
  openSessionForGroup(
    buildSessionMeta(sessionId, alerts[0] ?? null, undefined),
    groupKey,
  );
  return dispatcher.dispatch({ sessionId, alerts });
}

// A chat session's row, on the same terms: the route writes it before handing
// out the id, so a run dispatched into one always finds it there.
export function seedChatSession(sessionId: string, message?: string): void {
  createSession(buildSessionMeta(sessionId, null, message));
}

// Returns a valid nw_auth cookie for the given loginVersion (default 0, matching a fresh
// temp DB). Usage: headers: { cookie: `nw_auth=${await mintTestSession()}` }.
export async function mintTestSession(loginVersion = 0): Promise<string> {
  return mintSession(loginVersion);
}
