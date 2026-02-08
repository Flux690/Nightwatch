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
import { runAgent, AgentTool } from "../../llm/runtime";
import { infrastructure } from "../../infrastructure/compose";
import { loadKnowledge } from "../../infrastructure/knowledge";
import {
  inspectContainerTool,
  inspectContainerDeclaration,
} from "../../tools/docker";
import { loadPrompt } from "../../utils/promptLoader";
import { getErrorMessage } from "../../utils/helpers";
import { logger } from "../../utils/logger";
import schema from "./schema.json";

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

export const handler: CapabilityHandler = async (state) => {
  const result = await planRemediation(state);
  return result;
};

export async function planRemediation(
  state: IncidentResolutionState,
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

  // Get the root cause node by array index
  if (state.incidentGraph.root === null) {
    return failure(state, "Cannot plan: no root cause specified in graph.");
  }

  const rootNode = state.incidentGraph.nodes[state.incidentGraph.root];
  if (!rootNode) {
    return failure(state, "Cannot plan: root cause index out of bounds.");
  }

  // Build incident graph summary for the prompt
  const graphSummary = {
    summary: state.incidentGraph.summary,
    rootCause: {
      index: state.incidentGraph.root,
      container: rootNode.container,
      type: rootNode.type,
    },
    affectedComponents: state.incidentGraph.nodes.map((n, i) => ({
      index: i,
      container: n.container,
      type: n.type,
    })),
    causalChain: state.incidentGraph.edges.map((e) => `${e.from} -> ${e.to}`),
  };

  const knowledge = loadKnowledge();

  let userMessage = `
          ## Infrastructure
          \`\`\`yaml
          ${infrastructure.raw}
          \`\`\`
          
          ${
            knowledge
              ? `
            ## Known Facts
            ${knowledge}`
              : ""
          }

          ## Incident Graph
          ${JSON.stringify(graphSummary, null, 2)}

          ## Root Cause
          - Container: ${rootNode.container}
          - Type: ${rootNode.type}
          - Detected at: ${rootNode.timestamp}`;

  if (isReplanning && state.plan) {
    userMessage += `\n\n## Previous Plan\n${JSON.stringify(state.plan, null, 2)}`;
  }

  if (state.failureContext) {
    userMessage += `\n\n## Failure Context\n${JSON.stringify(state.failureContext, null, 2)}`;
  }

  const tools: AgentTool[] = [
    {
      declaration: inspectContainerDeclaration,
      handler: async (args) =>
        inspectContainerTool((args as { name: string }).name),
    },
  ];

  try {
    const { result, conversationHistory } = await runAgent<RemediationPlan>({
      systemInstruction: SYSTEM_PROMPT,
      initialUserMessage: userMessage,
      tools,
      conversationHistory: state.plannerHistory,
      responseSchema: schema,
    });

    const updatedState: IncidentResolutionState = {
      ...state,
      plan: result,
      plannerHistory: conversationHistory, // Update history in state
      planValidated: false,
      executionResult: null,
      verificationResult: null,
      failureContext: null,
    };

    return success(updatedState, { plan: result });
  } catch (err) {
    return failure(state, `Planning failed: ${getErrorMessage(err)}`);
  }
}
