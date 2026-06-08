import { z } from "zod";
import type {
  IncidentRecord,
  InvestigationResult,
  NormalizedAlert,
} from "@nightwatch/shared";
import { sendCommand } from "../ws/router.js";
import { logger } from "../logger.js";

// Best-effort persistence; the runner may be briefly offline at conclusion time.
const PERSIST_TIMEOUT_MS = 10_000;

// Mirrors the `conclude` tool's input_schema in tools.ts. Optional fields are
// nullable (not optional) to match the strict tool contract.
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

// The model delivers this as a validated `conclude` tool call, so `data` is
// already schema-checked by the loop - no text scraping, no JSON.parse here.
export async function conclude(
  alert: NormalizedAlert,
  incidentId: string,
  sessionId: string,
  data: InvestigationResult,
): Promise<void> {
  const record: IncidentRecord = {
    incidentId,
    sessionId,
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
    "investigation concluded",
  );
}

export async function escalate(
  alert: NormalizedAlert,
  incidentId: string,
  reason: string,
): Promise<void> {
  logger.warn(
    { incidentId, token: alert.token, reason },
    "investigation escalated to human",
  );
}
