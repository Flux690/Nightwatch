import { z } from "zod";
import type {
  IncidentRecord,
  InvestigationResult,
  NormalizedAlert,
} from "@nightwatch/shared";
import { sendCommand } from "../ws/router.js";
import { publishEscalated } from "../session/stream.js";
import { logger } from "../logger.js";

// Best-effort persistence; the runner may be briefly offline when the incident is written.
const PERSIST_TIMEOUT_MS = 10_000;

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
export async function recordFinding(
  alert: NormalizedAlert,
  incidentId: string,
  sessionId: string,
  data: InvestigationResult,
): Promise<void> {
  const record: IncidentRecord = {
    incidentId,
    sessionId,
    outcome: "finding",
    timestamp: alert.firedAt,
    containerName: alert.targetIdentifier,
    alertType: alert.alertType,
    rootCause: data.rootCause.summary,
    resolutionAction: data.recommendedAction?.toolName ?? null,
    resolvedAt: null,
    recurrenceCount: 0,
  };

  try {
    await sendCommand(
      alert.token,
      "write_incident",
      { ...record },
      PERSIST_TIMEOUT_MS,
    );
  } catch (err) {
    logger.error({ incidentId, err }, "failed to persist incident");
  }

  logger.info(
    {
      incidentId,
      action: data.recommendedAction?.toolName ?? "none",
      escalateIfRejected: data.escalateIfRejected,
    },
    "finding recorded",
  );
}

export async function escalate(
  alert: NormalizedAlert,
  incidentId: string,
  sessionId: string,
  reason: string,
): Promise<void> {
  logger.warn(
    { incidentId, sessionId, reason },
    "investigation escalated to human",
  );

  const record: IncidentRecord = {
    incidentId,
    sessionId,
    outcome: "escalated",
    timestamp: new Date().toISOString(),
    containerName: alert.targetIdentifier,
    alertType: alert.alertType,
    rootCause: reason,
    resolutionAction: null,
    resolvedAt: null,
    recurrenceCount: 0,
  };

  try {
    await sendCommand(
      alert.token,
      "write_incident",
      { ...record },
      PERSIST_TIMEOUT_MS,
    );
  } catch (err) {
    logger.error({ incidentId, err }, "failed to persist escalation incident");
  }

  publishEscalated({ sessionId, incidentId, reason });
}
