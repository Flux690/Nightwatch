import type { ServiceIdentity } from "./service-identity.js";

export type AlertSeverity = "critical" | "warning" | "info";

export interface NormalizedAlert {
  sourceAlertId: string;
  runnerId: string;
  // hostname of the server that sent this alert, stamped at ingest time from the
  // live runner registry. Preserved on the session row so history survives token
  // deletion (CONTEXT.md runner token lifecycle).
  hostname?: string;
  targetIdentifier: ServiceIdentity;
  alertType: string;
  severity: AlertSeverity;
  firedAt: string;
  rawPayload: unknown;
}
