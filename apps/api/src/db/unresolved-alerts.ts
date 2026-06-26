import type { AlertSeverity } from "@nightwatch/shared";
import { getDb } from "./client.js";

export interface UnresolvedAlert {
  id: number;
  sourceAlertId: string;
  identityKey: string;
  alertType: string;
  severity: AlertSeverity;
  rejectionReason: string;
  createdAt: string;
}

const SELECT_COLUMNS = `
  id,
  source_alert_id  AS sourceAlertId,
  identity_key     AS identityKey,
  alert_type       AS alertType,
  severity,
  rejection_reason AS rejectionReason,
  created_at       AS createdAt
`;

// INSERT OR REPLACE: the UNIQUE(source_alert_id) constraint means re-fires of
// the same fingerprint update the existing row rather than accumulating duplicates.
// The feed always shows the most recent rejection for each distinct alert.
export function insertUnresolvedAlert(params: {
  sourceAlertId: string;
  identityKey: string;
  alertType: string;
  severity: AlertSeverity;
  rejectionReason: string;
}): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO unresolved_alerts
         (source_alert_id, identity_key, alert_type, severity, rejection_reason, created_at)
       VALUES
         (@sourceAlertId, @identityKey, @alertType, @severity, @rejectionReason, @createdAt)`,
    )
    .run({ ...params, createdAt: new Date().toISOString() });
}

// Newest first, capped at 100 so a misconfigured sender cannot grow the result
// set without bound (mirrors the remediation-actions audit list).
export function listUnresolvedAlerts(): UnresolvedAlert[] {
  return (
    getDb()
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM unresolved_alerts ORDER BY created_at DESC, id DESC LIMIT 100`,
      )
      // better-sqlite3 types .all() as unknown[]; SELECT_COLUMNS aliases guarantee the row shape.
      .all() as UnresolvedAlert[]
  );
}
