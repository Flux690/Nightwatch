import { randomUUID } from "node:crypto";
import type {
  DeliveryContext,
  NormalizedAlert,
  SessionMeta,
} from "@nightwarden/shared";
import { mintSession } from "../auth/session.js";
import { buildSessionMeta } from "../agent/loop.js";
import { dispatcher } from "../dispatcher.js";
import {
  createSession,
  enqueueAlerts,
  openSessionForGroup,
} from "../db/sessions.js";

// A sender that withheld nothing and described the group not at all: the shape
// every test that is not about the envelope wants.
export const WHOLE_DELIVERY: DeliveryContext = {
  droppedAlerts: 0,
  groupContext: null,
};

// By the only route production has: queued under a group key, then taken. A
// direct insert would build a shape ingest cannot produce.
export function seedAlertSession(
  meta: SessionMeta,
  alerts: NormalizedAlert[],
  groupKey = `test-group-${randomUUID()}`,
): void {
  if (alerts.length === 0) {
    createSession(meta, true);
    return;
  }
  enqueueAlerts(groupKey, alerts, WHOLE_DELIVERY);
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
  enqueueAlerts(groupKey, alerts, WHOLE_DELIVERY);
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
