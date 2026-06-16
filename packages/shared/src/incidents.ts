export type AlertSeverity = "critical" | "warning" | "info";
export type IncidentStatus =
  | "investigating"
  | "resolved"
  | "escalated"
  | "dismissed";

export interface NormalizedAlert {
  sourceAlertId: string;
  // token is the tokenId (UUID primary key) of the runner token that authenticated
  // this alert. It is the stable per-server key for dedup and rate-limit.
  token: string;
  // hostname of the server that sent this alert, stamped at ingest time from the
  // live runner registry. Preserved on the session row so history survives token
  // deletion (CONTEXT.md runner token lifecycle).
  hostname?: string;
  targetIdentifier: string;
  alertType: string;
  severity: AlertSeverity;
  firedAt: string;
  rawPayload: unknown;
}

export interface IncidentRecord {
  incidentId: string;
  // The session this incident came from. Optional for records written before
  // sessions existed; populated by escalate() going forward.
  sessionId?: string;
  // finding = the agent diagnosed a root cause (legacy records); escalated =
  // the agent handed off to the human. Episodic memory must not present an
  // escalation reason as a diagnosed root cause.
  outcome: "finding" | "escalated";
  timestamp: string;
  containerName: string;
  alertType: string;
  rootCause: string;
  resolutionAction: string | null;
  resolvedAt: string | null;
  humanResolutionNote?: string;
  recurrenceCount: number;
}
