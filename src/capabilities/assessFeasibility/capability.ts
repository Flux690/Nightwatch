/**
 * Assess whether a safe remediation plan can be produced for the incident.
 */

import type { IncidentResolutionState } from "../../orchestration/state";
import type {
  CapabilityConfig,
  CapabilityHandler,
  CapabilityResult,
} from "../types";
import type { FeasibilityAssessment } from "../../types";
import { success, failure } from "../types";
import { runAgent, AgentTool } from "../../llm/runtime";
import { infrastructure } from "../../infrastructure/compose";
import { loadKnowledge } from "../../infrastructure/knowledge";
import {
  inspectContainerTool,
  inspectContainerDeclaration,
} from "../../tools/docker";
import { askUserTool, askUserDeclaration } from "../../tools/user";
import { loadPrompt } from "../../utils/promptLoader";
import { getErrorMessage } from "../../utils/helpers";
import { logger } from "../../utils/logger";
import schema from "./schema.json";

const SYSTEM_PROMPT = loadPrompt(import.meta.url);

export type FeasibilityData = {
  feasibility: FeasibilityAssessment;
};

export const config: CapabilityConfig = {
  stage: "Feasibility",
  action: "Assessing remediation feasibility",
  logResult: (state, result) => {
    if (result.success && state.feasibility) {
      logger.feasibility(state.feasibility);
    } else {
      logger.result(false, "Feasibility assessment failed", {
        Error: result.error ?? "Unknown",
      });
    }
  },
};

export const handler: CapabilityHandler = async (state) => {
  const result = await assessFeasibility(state);
  return result;
};

export async function assessFeasibility(
  state: IncidentResolutionState,
): Promise<CapabilityResult<FeasibilityData>> {
  if (!state.incidentGraph || state.incidentGraph.nodes.length === 0) {
    return failure(state, "Cannot assess feasibility: no incident identified.");
  }

  if (state.incidentGraph.root === null) {
    return failure(
      state,
      "Cannot assess feasibility: no root cause specified in graph.",
    );
  }

  const rootNode = state.incidentGraph.nodes[state.incidentGraph.root];
  if (!rootNode) {
    return failure(
      state,
      "Cannot assess feasibility: root cause index out of bounds.",
    );
  }

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

  const userMessage = `
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
          - Detected at: ${rootNode.timestamp}

          Determine whether a safe, deterministic remediation plan can be produced.`;

  const tools: AgentTool[] = [
    {
      declaration: inspectContainerDeclaration,
      handler: async (args) =>
        inspectContainerTool((args as { name: string }).name),
    },
    {
      declaration: askUserDeclaration,
      handler: async (args) => askUserTool(args as { question: string }),
    },
  ];

  try {
    const { result } = await runAgent<FeasibilityAssessment>({
      systemInstruction: SYSTEM_PROMPT,
      initialUserMessage: userMessage,
      tools,
      responseSchema: schema,
    });

    const updatedState: IncidentResolutionState = {
      ...state,
      feasibility: result,
    };

    return success(updatedState, { feasibility: result });
  } catch (err) {
    return failure(
      state,
      `Feasibility assessment failed: ${getErrorMessage(err)}`,
    );
  }
}
