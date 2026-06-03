import { z } from "zod";
import type { NormalizedAlert } from "@nightwatch/shared";

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
      params: z.record(z.unknown()),
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

  console.log(
    `[loop] concluded incidentId=${incidentId} confidence=${result.data.rootCause.confidence} action=${result.data.recommendedAction?.toolName ?? "none"}`,
  );
}

export async function escalate(
  alert: NormalizedAlert,
  incidentId: string,
  reason: string,
): Promise<void> {
  console.error(
    `[loop] ESCALATE incidentId=${incidentId} installation=${alert.installationId} reason=${reason}`,
  );
  /* Phase 5: post escalation card to Slack */
}
