import type {
  AlertGroupContext,
  NormalizedAlert,
  SessionAlert,
} from "@nightwarden/shared";
import type { DeliveryContext } from "../alerts/delivery.js";
import { getDb } from "../db.js";

// Every alert row: the queue before a session owns one, and the group coverage
// that decides which investigation an arriving alert joins.

const INSERT_ALERT = `INSERT INTO alerts
     (session_id, group_key, source_alert_id, fired_at, arrived_at, cleared_at,
      injected, dropped_alerts, group_context, alert)
   VALUES (@sessionId, @groupKey, @sourceAlertId, @firedAt, @arrivedAt, NULL,
      @injected, @droppedAlerts, @groupContext, @alert)`;

// Denormalised onto every alert the delivery carried: a row is durable before
// any session owns it, so a queued alert has nowhere else to read them from.
function alertParams(
  sessionId: string | null,
  groupKey: string,
  alert: NormalizedAlert,
  arrivedAt: string,
  injected: boolean,
  delivery: DeliveryContext,
): Record<string, string | number | null> {
  return {
    sessionId,
    groupKey,
    sourceAlertId: alert.sourceAlertId,
    firedAt: alert.firedAt,
    arrivedAt,
    injected: injected ? 1 : 0,
    droppedAlerts: delivery.droppedAlerts,
    groupContext:
      delivery.groupContext === null
        ? null
        : JSON.stringify(delivery.groupContext),
    alert: JSON.stringify(alert),
  };
}

// Durable the moment we answer 200, before anything decides whether a seat is
// free. What makes them one investigation is the sender's group key.
export function enqueueAlerts(
  groupKey: string,
  alerts: NormalizedAlert[],
  delivery: DeliveryContext,
): void {
  if (alerts.length === 0) return;
  const db = getDb();
  const insert = db.prepare(INSERT_ALERT);
  const arrivedAt = new Date().toISOString();
  db.transaction((): void => {
    for (const alert of alerts) {
      insert.run(
        alertParams(null, groupKey, alert, arrivedAt, false, delivery),
      );
    }
  })();
}

// An alert that arrived while the run was already working. `arrivedAt` is what
// later places it in the transcript, at the turn it interrupted.
export function appendSessionAlert(
  sessionId: string,
  groupKey: string,
  alert: NormalizedAlert,
  delivery: DeliveryContext,
): void {
  getDb()
    .prepare(INSERT_ALERT)
    .run(
      alertParams(
        sessionId,
        groupKey,
        alert,
        new Date().toISOString(),
        true,
        delivery,
      ),
    );
}

// Queued rows included: an alert that recovers while waiting for a seat is
// cleared here and never promoted. First clear wins.
export function markAlertCleared(
  sourceAlertId: string,
  clearedAt: string,
): string[] {
  const rows = getDb()
    .prepare(
      `UPDATE alerts SET cleared_at = @clearedAt
       WHERE source_alert_id = @sourceAlertId AND cleared_at IS NULL
       RETURNING session_id AS sessionId`,
    )
    .all({ sourceAlertId, clearedAt }) as Array<{ sessionId: string | null }>;
  // A queued row has no session to publish against. One session can also cover
  // the same alert twice; the caller wants sessions.
  return [
    ...new Set(
      rows.map((r) => r.sessionId).filter((id): id is string => id !== null),
    ),
  ];
}

// Scoped to uncleared rows rather than live runs: Alertmanager repeats a firing
// alert, so a narrower rule reopens the same one every few minutes.
export function isAlertCovered(
  sourceAlertId: string,
  firedAt: string,
): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1 FROM alerts
       WHERE source_alert_id = ? AND fired_at = ? AND cleared_at IS NULL
       LIMIT 1`,
    )
    .get(sourceAlertId, firedAt);
  return row !== undefined;
}

// Alertmanager grouped these under the user's own `group_by`, so this is their
// decision arriving as data, never a relationship we inferred.

export function sessionCoveringGroup(groupKey: string): string | undefined {
  const row = getDb()
    .prepare(
      `SELECT a.session_id AS sessionId
       FROM alerts a
       JOIN sessions s ON s.session_id = a.session_id
       WHERE a.group_key = ? AND s.run_state IN ('running', 'suspended')
       LIMIT 1`,
    )
    .get(groupKey) as { sessionId: string } | undefined;
  return row?.sessionId;
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

export const QUEUED = `session_id IS NULL AND cleared_at IS NULL`;

// Cleared rows are skipped rather than promoted: opening an investigation into a
// condition that is already over is worse than silence.
export function oldestQueuedGroup(): QueuedGroup | undefined {
  const db = getDb();
  const head = db
    .prepare(
      `SELECT group_key AS groupKey FROM alerts
       WHERE ${QUEUED} ORDER BY arrived_at ASC, id ASC LIMIT 1`,
    )
    .get() as { groupKey: string } | undefined;
  if (head === undefined) return undefined;

  const rows = db
    .prepare(
      `SELECT alert FROM alerts
       WHERE group_key = ? AND ${QUEUED} ORDER BY id ASC`,
    )
    .all(head.groupKey) as Array<{ alert: string }>;
  const alerts = rows.flatMap((r) => parseAlert(r.alert));
  return alerts.length === 0 ? undefined : { groupKey: head.groupKey, alerts };
}

// What the console's queue band reports: how many alerts are waiting, and how
// long the one at the front has been waiting.
export function queueDepth(): {
  waiting: number;
  oldestArrivedAt: string | null;
} {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS waiting, MIN(arrived_at) AS oldestArrivedAt
       FROM alerts WHERE ${QUEUED}`,
    )
    .get() as { waiting: number; oldestArrivedAt: string | null };
  return row;
}

interface AlertRow {
  sessionId: string;
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

const ALERT_COLUMNS = `session_id AS sessionId, arrived_at AS arrivedAt,
        cleared_at AS clearedAt, injected, dropped_alerts AS droppedAlerts,
        group_context AS groupContext, alert`;

// id ascending is arrival order, which is what the first alert of a batch means
// to everything that reads one.
export function alertsFor(sessionId: string): SessionAlert[] {
  const rows = getDb()
    .prepare(
      `SELECT ${ALERT_COLUMNS} FROM alerts
       WHERE session_id = ? ORDER BY id ASC`,
    )
    .all(sessionId) as AlertRow[];
  return rows.flatMap(toSessionAlert);
}

// One query for a whole page of sessions, rather than a correlated subquery per
// row: the page is bounded, so this is two statements however long the list is.
export function alertsForMany(
  sessionIds: string[],
): Map<string, SessionAlert[]> {
  const byId = new Map<string, SessionAlert[]>();
  if (sessionIds.length === 0) return byId;
  const holes = sessionIds.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT ${ALERT_COLUMNS} FROM alerts
       WHERE session_id IN (${holes}) ORDER BY id ASC`,
    )
    .all(...sessionIds) as AlertRow[];
  for (const row of rows) {
    const entries = byId.get(row.sessionId) ?? [];
    entries.push(...toSessionAlert(row));
    byId.set(row.sessionId, entries);
  }
  return byId;
}

// What the reconciler works through. Queued alerts are excluded: nothing has
// investigated them, so there is no recovery to verify.
export function sessionIdsWithOpenAlerts(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT session_id AS sessionId FROM alerts
       WHERE cleared_at IS NULL AND session_id IS NOT NULL
       ORDER BY session_id`,
    )
    .all() as Array<{ sessionId: string }>;
  return rows.map((r) => r.sessionId);
}
