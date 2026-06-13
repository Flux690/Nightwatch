import { z } from "zod";
import type { IncidentRecord, InvestigationResult } from "@nightwatch/shared";
import { insertIncident } from "../db/incidents.js";
import { publishEscalated } from "../session/stream.js";
import { logger } from "../logger.js";

// The incident store is token-scoped and one alert may concern any container, so
// the finding/escalation writers carry just the fields an incident needs - not a
// whole NormalizedAlert (a chat session has none).
export interface IncidentContext {
  token: string;
  containerName: string;
  alertType: string;
  firedAt: string;
}

// Mirrors the `final_response` tool's input_schema in tools.ts. Optional fields
// are nullable (not optional) to match the strict tool contract.
export const InvestigationResultSchema = z.object({
  rootCause: z.object({
    summary: z.string(),
    evidence: z.array(z.string()),
    contributingFactors: z.array(z.string()).nullable(),
  }),
  recommendedAction: z
    .object({
      toolName: z.string(),
      targetContainer: z.string(),
      rationale: z.string(),
      risk: z.enum(["low", "medium", "high"]),
      estimatedDowntimeSeconds: z.number(),
      followUp: z.string().nullable(),
    })
    .nullable(),
  escalateIfRejected: z.boolean(),
  investigationSteps: z.array(z.string()),
});

// The model delivers this as a validated `final_response` tool call (or via
// native structured output synthesized into one), so `data` is already
// schema-checked by the loop - no text scraping, no JSON.parse here.
export function recordFinding(
  ctx: IncidentContext,
  incidentId: string,
  sessionId: string,
  data: InvestigationResult,
): void {
  const record: IncidentRecord = {
    incidentId,
    sessionId,
    outcome: "finding",
    timestamp: ctx.firedAt,
    containerName: ctx.containerName,
    alertType: ctx.alertType,
    rootCause: data.rootCause.summary,
    resolutionAction: data.recommendedAction?.toolName ?? null,
    resolvedAt: null,
    recurrenceCount: 0,
  };

  // Local, synchronous, transactional - never best-effort over a socket.
  insertIncident(ctx.token, record);

  logger.info(
    {
      incidentId,
      action: data.recommendedAction?.toolName ?? "none",
      escalateIfRejected: data.escalateIfRejected,
    },
    "finding recorded",
  );
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
