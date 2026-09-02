import type {
  AlertGroupContext,
  NormalizedAlert,
  SessionAlert,
} from "@nightwarden/shared";
import type { DeliveryContext } from "../alerts/delivery.js";
import type { ExpressionBuilder } from "kysely";
import { getDb } from "../db.js";
import type { Database } from "../schema.js";
import { refreshSessionStatus } from "./status-store.js";

// Every alert row: the queue before a session owns one, and the group coverage
// that decides which investigation an arriving alert joins.

// Denormalised onto every alert the delivery carried: a row is durable before
// any session owns it, so a queued alert has nowhere else to read them from.
function alertRow(
  sessionId: string | null,
  groupKey: string,
  alert: NormalizedAlert,
  arrivedAt: string,
  injected: boolean,
  delivery: DeliveryContext,
) {
  return {
    session_id: sessionId,
    group_key: groupKey,
    source_alert_id: alert.sourceAlertId,
    labels: JSON.stringify(alert.labels),
    alert_type: alert.alertType,
    fired_at: alert.firedAt,
    arrived_at: arrivedAt,
    cleared_at: null,
    injected: injected ? 1 : 0,
    dropped_alerts: delivery.droppedAlerts,
    group_context:
      delivery.groupContext === null
        ? null
        : JSON.stringify(delivery.groupContext),
    alert: JSON.stringify(alert),
  };
}

// Durable the moment we answer 200, before anything decides whether a seat is
// free. What makes them one investigation is the sender's group key.
export async function enqueueAlerts(
  groupKey: string,
  alerts: NormalizedAlert[],
  delivery: DeliveryContext,
): Promise<void> {
  if (alerts.length === 0) return;
  const arrivedAt = new Date().toISOString();
  await getDb()
    .insertInto("alerts")
    .values(
      alerts.map((alert) =>
        alertRow(null, groupKey, alert, arrivedAt, false, delivery),
      ),
    )
    .execute();
}

// An alert that arrived while the run was already working. `arrivedAt` is what
// later places it in the transcript, at the turn it interrupted.
export async function appendSessionAlert(
  sessionId: string,
  groupKey: string,
  alert: NormalizedAlert,
  delivery: DeliveryContext,
): Promise<void> {
  await getDb()
    .insertInto("alerts")
    .values(
      alertRow(
        sessionId,
        groupKey,
        alert,
        new Date().toISOString(),
        true,
        delivery,
      ),
    )
    .execute();
}

/* Keyed the way dedup keys, so a recovery clears the firing it names rather than
   an older one sharing the fingerprint. Queued rows are included. */
export async function markAlertCleared(
  sourceAlertId: string,
  firedAt: string,
  clearedAt: string,
): Promise<string[]> {
  const rows = await getDb()
    .updateTable("alerts")
    .set({ cleared_at: clearedAt })
    .where("source_alert_id", "=", sourceAlertId)
    .where("fired_at", "=", firedAt)
    .where("cleared_at", "is", null)
    .returning("session_id as sessionId")
    .execute();
  // A queued row has no session to publish against. One session can also cover
  // the same alert twice; the caller wants sessions.
  const sessionIds = [
    ...new Set(
      rows.map((r) => r.sessionId).filter((id): id is string => id !== null),
    ),
  ];
  // The last alert clearing is what makes a session read as resolved.
  for (const sessionId of sessionIds) await refreshSessionStatus(sessionId);
  return sessionIds;
}

// Scoped to uncleared rows rather than live runs: Alertmanager repeats a firing
// alert, so a narrower rule reopens the same one every few minutes.
export async function isAlertCovered(
  sourceAlertId: string,
  firedAt: string,
): Promise<boolean> {
  const row = await getDb()
    .selectFrom("alerts")
    .select("id")
    .where("source_alert_id", "=", sourceAlertId)
    .where("fired_at", "=", firedAt)
    .where("cleared_at", "is", null)
    .executeTakeFirst();
  return row !== undefined;
}

// Alertmanager grouped these under the user's own `group_by`, so this is their
// decision arriving as data, never a relationship we inferred.

export async function sessionCoveringGroup(
  groupKey: string,
): Promise<string | undefined> {
  const row = await getDb()
    .selectFrom("alerts as a")
    .innerJoin("sessions as s", "s.session_id", "a.session_id")
    .select("a.session_id as sessionId")
    .where("a.group_key", "=", groupKey)
    .where("s.status", "in", ["running", "action_required"])
    .executeTakeFirst();
  return row?.sessionId ?? undefined;
}

// One group of alerts waiting for a seat, ready to become a session.
export interface QueuedGroup {
  groupKey: string;
  alerts: NormalizedAlert[];
}

function parseAlert(raw: string): NormalizedAlert[] {
  try {
    return [JSON.parse(raw) as NormalizedAlert];
  } catch {
    return [];
  }
}

// A row nothing has taken yet. Shared with session/store.ts, which assigns a
// group to the session that takes it.
export function isQueued(eb: ExpressionBuilder<Database, "alerts">) {
  return eb.and([eb("session_id", "is", null), eb("cleared_at", "is", null)]);
}

// Cleared rows are skipped rather than promoted: opening an investigation into a
// condition that is already over is worse than silence.
export async function oldestQueuedGroup(): Promise<QueuedGroup | undefined> {
  const db = getDb();
  const head = await db
    .selectFrom("alerts")
    .select("group_key as groupKey")
    .where(isQueued)
    .orderBy("arrived_at", "asc")
    .orderBy("id", "asc")
    .executeTakeFirst();
  if (head === undefined) return undefined;

  const rows = await db
    .selectFrom("alerts")
    .select("alert")
    .where("group_key", "=", head.groupKey)
    .where(isQueued)
    .orderBy("id", "asc")
    .execute();
  const alerts = rows.flatMap((r) => parseAlert(r.alert));
  return alerts.length === 0 ? undefined : { groupKey: head.groupKey, alerts };
}

// What the frontend's queue band reports: how many alerts are waiting, and how
// long the one at the front has been waiting.
export async function queueDepth(): Promise<{
  waiting: number;
  oldestArrivedAt: string | null;
}> {
  const row = await getDb()
    .selectFrom("alerts")
    .select((eb) => [
      eb.fn.countAll<number>().as("waiting"),
      eb.fn.min<string | null>("arrived_at").as("oldestArrivedAt"),
    ])
    .where(isQueued)
    .executeTakeFirst();
  return {
    waiting: row?.waiting ?? 0,
    oldestArrivedAt: row?.oldestArrivedAt ?? null,
  };
}

interface AlertRow {
  // Null on a row still waiting for a seat, which no session owns yet.
  sessionId: string | null;
  arrivedAt: string;
  clearedAt: string | null;
  injected: number;
  droppedAlerts: number;
  groupContext: string | null;
  alert: string;
}

// Untrusted on read for the same reason as the canonical column below: a session
// holding one unreadable alert should still open, showing the rest.
function toSessionAlert(row: AlertRow): SessionAlert[] {
  try {
    return [
      {
        alert: JSON.parse(row.alert) as NormalizedAlert,
        arrivedAt: row.arrivedAt,
        clearedAt: row.clearedAt,
        injected: row.injected === 1,
        droppedAlerts: row.droppedAlerts,
        groupContext:
          row.groupContext === null
            ? null
            : (JSON.parse(row.groupContext) as AlertGroupContext),
      },
    ];
  } catch {
    return [];
  }
}

const ALERT_COLUMNS = [
  "session_id as sessionId",
  "arrived_at as arrivedAt",
  "cleared_at as clearedAt",
  "injected",
  "dropped_alerts as droppedAlerts",
  "group_context as groupContext",
  "alert",
] as const;

// id ascending is arrival order, which is what the first alert of a batch means
// to everything that reads one.
export async function alertsFor(sessionId: string): Promise<SessionAlert[]> {
  const rows = await getDb()
    .selectFrom("alerts")
    .select(ALERT_COLUMNS)
    .where("session_id", "=", sessionId)
    .orderBy("id", "asc")
    .execute();
  return rows.flatMap(toSessionAlert);
}

// One query for a whole page of sessions, rather than a correlated subquery per
// row: the page is bounded, so this is two statements however long the list is.
export async function alertsForMany(
  sessionIds: string[],
): Promise<Map<string, SessionAlert[]>> {
  const byId = new Map<string, SessionAlert[]>();
  if (sessionIds.length === 0) return byId;
  const rows = await getDb()
    .selectFrom("alerts")
    .select(ALERT_COLUMNS)
    .where("session_id", "in", sessionIds)
    .orderBy("id", "asc")
    .execute();
  for (const row of rows) {
    if (row.sessionId === null) continue;
    const entries = byId.get(row.sessionId) ?? [];
    entries.push(...toSessionAlert(row));
    byId.set(row.sessionId, entries);
  }
  return byId;
}

// What the reconciler works through. Queued alerts are excluded: nothing has
// investigated them, so there is no recovery to verify.
export async function sessionIdsWithOpenAlerts(): Promise<string[]> {
  const rows = await getDb()
    .selectFrom("alerts")
    .select("session_id as sessionId")
    .distinct()
    .where("cleared_at", "is", null)
    .where("session_id", "is not", null)
    .orderBy("session_id")
    .execute();
  return rows.flatMap((r) => (r.sessionId === null ? [] : [r.sessionId]));
}
