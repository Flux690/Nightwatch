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

export interface InvestigationResult {
  rootCause: {
    summary: string;
    confidence: number;
    evidence: string[];
    contributingFactors?: string[];
  };
  recommendedAction: {
    toolName: string;
    targetContainer: string;
    params: Record<string, unknown>;
    rationale: string;
    risk: "low" | "medium" | "high";
    estimatedDowntimeSeconds: number;
    followUp?: string;
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
