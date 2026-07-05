import type { AlertSeverity } from "./alerts.js";

export interface UnresolvedAlertRecord {
  sourceAlertId: string;
  identityKey: string;
  alertType: string;
  severity: AlertSeverity;
  rejectionReason: string;
  createdAt: string;
}
