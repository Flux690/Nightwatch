import { z } from "zod";
import type { IncidentRecord, NormalizedAlert } from "@nightwatch/shared";
import { sendCommand } from "../ws/router.js";
import { logger } from "../logger.js";

// Best-effort persistence; the runner may be briefly offline at conclusion time.
const PERSIST_TIMEOUT_MS = 10_000;

export const InvestigationResultSchema = z.object({
  rootCause: z.object({
    summary: z.string(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.string()),
    contributingFactors: z.array(z.string()).optional(),
  }),
  recommendedAction: z
    .object({
      toolName: z.string(),
      targetContainer: z.string(),
      params: z.record(z.string(), z.unknown()),
      rationale: z.string(),
      risk: z.enum(["low", "medium", "high"]),
      estimatedDowntimeSeconds: z.number(),
      followUp: z.string().optional(),
    })
    .nullable(),
  escalateIfRejected: z.boolean(),
  investigationSteps: z.array(z.string()),
});

export async function conclude(
  alert: NormalizedAlert,
  incidentId: string,
  rawText: string,
): Promise<void> {
  let parsed: unknown;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch?.[0] ?? rawText);
  } catch {
    await escalate(
      alert,
      incidentId,
      `Could not parse result JSON: ${rawText.slice(0, 200)}`,
    );
    return;
  }

  const result = InvestigationResultSchema.safeParse(parsed);
  if (!result.success) {
    await escalate(
      alert,
      incidentId,
      `Result failed schema validation: ${result.error.message}`,
    );
    return;
  }

  const data = result.data;
  const record: IncidentRecord = {
    incidentId,
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
      confidence: data.rootCause.confidence,
      action: data.recommendedAction?.toolName ?? "none",
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
