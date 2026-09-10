import { randomUUID } from "node:crypto";
import type { NormalizedAlert, SessionMeta } from "@nightwarden/shared";
import type { DeliveryContext } from "../alerts/delivery.js";
import { getAuth } from "../auth/instance.js";
import { getDb } from "../db.js";
import { buildSessionMeta } from "../agent/loop/run-session.js";
import { dispatcher } from "../dispatcher.js";
import { enqueueAlerts } from "../session/alerts-store.js";
import { createSession, openSessionForGroup } from "../session/store.js";

// A sender that withheld nothing and described the group not at all: the shape
// every test that is not about the envelope wants.
export const WHOLE_DELIVERY: DeliveryContext = {
  droppedAlerts: 0,
  groupContext: null,
};

// By the only route production has: queued under a group key, then taken. A
// direct insert would build a shape ingest cannot produce.
export async function seedAlertSession(
  meta: SessionMeta,
  alerts: NormalizedAlert[],
  groupKey = `test-group-${randomUUID()}`,
): Promise<void> {
  if (alerts.length === 0) {
    await createSession(meta, true);
    return;
  }
  await enqueueAlerts(groupKey, alerts, WHOLE_DELIVERY);
  await openSessionForGroup(meta, groupKey);
}

// The row and its alerts exist before anything dispatches into it, so a test
// that skips this is testing a shape ingest cannot reach.
export async function dispatchAlertSession(
  sessionId: string,
  alerts: NormalizedAlert[],
  groupKey = `test-group-${randomUUID()}`,
): Promise<boolean> {
  // Queued first, then the session takes them - the order promotion uses, and
  // what makes an opening alert predate the session it opened.
  await enqueueAlerts(groupKey, alerts, WHOLE_DELIVERY);
  await openSessionForGroup(
    buildSessionMeta(sessionId, alerts[0] ?? null, undefined),
    groupKey,
  );
  return await dispatcher.dispatch({ sessionId, alerts });
}

// A chat session's row, on the same terms: the route writes it before handing
// out the id, so a run dispatched into one always finds it there.
export async function seedChatSession(
  sessionId: string,
  message?: string,
): Promise<void> {
  await createSession(buildSessionMeta(sessionId, null, message));
}

/* A real signed-in session, issued the way production does: the owner is created
   through the signup door, so the cookie is one Better Auth actually issued. */
export async function issueTestSession(): Promise<string> {
  const auth = getAuth();
  const body = {
    email: "owner@example.test",
    password: "a-long-enough-password",
    name: "Owner",
  };
  const existing = await getDb()
    .selectFrom("user")
    .select("id")
    .executeTakeFirst();
  const response = existing
    ? await auth.api.signInEmail({ body, asResponse: true })
    : await auth.api.signUpEmail({ body, asResponse: true });
  // Returned as a Cookie request header, which is what every caller sends back.
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
