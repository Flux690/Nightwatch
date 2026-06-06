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

// Shape of a concluded investigation. Optional fields are nullable (not
// optional) to match the strict `conclude` tool contract the model fills in.
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
  timestamp: string;
  containerName: string;
  alertType: string;
  rootCause: string;
  resolutionAction: string | null;
  resolvedAt: string | null;
  humanResolutionNote?: string;
  recurrenceCount: number;
}
