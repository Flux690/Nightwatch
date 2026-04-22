/**
 * Generate a remediation plan for the identified incident.
 */

import type { IncidentResolutionState } from "../../orchestration/state";
import type {
  CapabilityConfig,
  CapabilityHandler,
  CapabilityResult,
} from "../types";
import type { RemediationPlan } from "../../types";
import { success, failure } from "../types";
import { runAgent } from "../../llm/runtime";
import { createDiagnosticTools } from "../../tools/docker";
import type { ToolCache } from "../../tools/cache";
import { loadPrompt } from "../../utils/promptLoader";
import { getErrorMessage } from "../../utils/helpers";
import { logger } from "../../utils/logger";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(path.join(__dirname, "schema.json"), "utf-8"));

const SYSTEM_PROMPT = loadPrompt(import.meta.url);

export type PlanRemediationData = {
  plan: RemediationPlan;
};

export const config: CapabilityConfig = {
  stage: (state) => (state.failureContext ? "Replanning" : "Planning"),
  action: (state) =>
    state.failureContext
      ? "Generating revised remediation plan"
      : "Generating remediation plan",
  logResult: (state, result) => {
    if (result.success && result.data) {
      const data = result.data as PlanRemediationData;
      logger.plan(data.plan);
    } else {
      logger.result(false, "Plan generation failed", {
        Error: result.error ?? "Unknown",
      });
    }
  },
};

export const handler: CapabilityHandler = async (state, toolCache) => {
  const result = await planRemediation(state, toolCache);
  return result;
};

export async function planRemediation(
  state: IncidentResolutionState,
  toolCache?: ToolCache,
): Promise<CapabilityResult<PlanRemediationData>> {
  if (!state.incidentGraph || state.incidentGraph.nodes.length === 0) {
    return failure(state, "Cannot plan: no incident identified.");
  }

  if (!state.feasibility) {
    return failure(state, "Cannot plan: feasibility not assessed.");
  }

  if (!state.feasibility.feasible) {
    return failure(
      state,
      `Cannot plan: not feasible. Reason: ${state.feasibility.blocking_reason}`,
    );
  }

  const isReplanning = state.plan !== null && state.failureContext !== null;

  if (state.plan !== null && state.failureContext === null) {
    return failure(state, "Plan already exists without failure context.");
  }

  // Incident graph, infrastructure, and knowledge are already in shared history
  // from analyzer and feasibility phases. Only inject NEW information.
  let userMessage: string;

  if (isReplanning && state.failureContext) {
    userMessage = `## Failure Context\n${JSON.stringify(state.failureContext, null, 2)}\n\nGenerate a revised remediation plan addressing the failure above.`;
  } else {
    userMessage = `Generate a remediation plan for the incident assessed above.`;
  }

  const tools = createDiagnosticTools(toolCache);

  try {
    const { result, conversationHistory } = await runAgent<RemediationPlan>({
      systemInstruction: SYSTEM_PROMPT,
      initialUserMessage: userMessage,
      tools,
      conversationHistory: state.sharedHistory,
      responseSchema: schema,
    });

    const updatedState: IncidentResolutionState = {
      ...state,
      plan: result,
      sharedHistory: conversationHistory,
      planValidated: false,
      approved: false,
      executionResult: null,
      verificationResult: null,
      failureContext: null,
    };

    return success(updatedState, { plan: result });
  } catch (err) {
    return failure(state, `Planning failed: ${getErrorMessage(err)}`);
  }
}
