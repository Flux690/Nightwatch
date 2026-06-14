import type { IncidentRecord } from "@nightwatch/shared";
import { insertIncident } from "../db/incidents.js";
import { publishEscalated } from "../session/stream.js";
import { logger } from "../logger.js";

// The incident store is token-scoped and one alert may concern any container, so
// the escalation writer carries just the fields an incident needs - not a whole
// NormalizedAlert (a chat session has none).
export interface IncidentContext {
  token: string;
  containerName: string;
  alertType: string;
  firedAt: string;
}

export function escalate(
  ctx: IncidentContext,
  incidentId: string,
  sessionId: string,
  reason: string,
): void {
  logger.warn(
    { incidentId, sessionId, reason },
    "investigation escalated to human",
  );

  const record: IncidentRecord = {
    incidentId,
    sessionId,
    outcome: "escalated",
    timestamp: new Date().toISOString(),
    containerName: ctx.containerName,
    alertType: ctx.alertType,
    rootCause: reason,
    resolutionAction: null,
    resolvedAt: null,
    recurrenceCount: 0,
  };

  insertIncident(ctx.token, record);

  publishEscalated({ sessionId, incidentId, reason });
}
