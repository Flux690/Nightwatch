export type AlertSeverity = "critical" | "warning" | "info";
export type IncidentStatus =
  | "investigating"
  | "resolved"
  | "escalated"
  | "dismissed";

export interface NormalizedAlert {
  sourceAlertId: string;
  token: string;
  targetIdentifier: string;
  alertType: string;
  severity: AlertSeverity;
  firedAt: string;
  rawPayload: unknown;
}

// Shape of a completed investigation. Optional fields are nullable (not
// optional) to match the strict `final_response` tool contract the model
// fills in.
export interface InvestigationResult {
  rootCause: {
    summary: string;
    evidence: string[];
    contributingFactors: string[] | null;
  };
  recommendedAction: {
    toolName: string;
    targetContainer: string;
    rationale: string;
    risk: "low" | "medium" | "high";
    estimatedDowntimeSeconds: number;
    followUp: string | null;
  } | null;
  escalateIfRejected: boolean;
  investigationSteps: string[];
}

export interface IncidentRecord {
  incidentId: string;
  // The session this incident came from. Optional for records written before
  // sessions existed; populated by recordFinding()/escalate() going forward.
  sessionId?: string;
  // finding = the agent diagnosed and delivered a final_response; escalated =
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
