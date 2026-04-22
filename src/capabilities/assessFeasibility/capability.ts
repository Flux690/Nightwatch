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
import { runAgent } from "../../llm/runtime";
import { getInfrastructure } from "../../globals";
import { loadKnowledge } from "../../llm/knowledge";
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

export const handler: CapabilityHandler = async (state, toolCache) => {
  const result = await assessFeasibility(state, toolCache);
  return result;
};

export async function assessFeasibility(
  state: IncidentResolutionState,
  toolCache?: ToolCache,
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

  const infra = getInfrastructure();
  const knowledge = loadKnowledge(infra.basePath);

  // Infrastructure and knowledge are new data not yet in conversation history.
  // Incident graph details are already in history from the analyzer phase.
  const userMessage = `## Infrastructure
\`\`\`yaml
${infra.raw}
\`\`\`
${knowledge ? `\n## Known Facts\n${knowledge}\n` : ""}
Assess feasibility of remediating the incident identified above.`;

  const tools = createDiagnosticTools(toolCache);

  try {
    const { result, conversationHistory } = await runAgent<FeasibilityAssessment>({
      systemInstruction: SYSTEM_PROMPT,
      initialUserMessage: userMessage,
      tools,
      conversationHistory: state.sharedHistory,
      responseSchema: schema,
    });

    const updatedState: IncidentResolutionState = {
      ...state,
      feasibility: result,
      sharedHistory: conversationHistory,
    };

    return success(updatedState, { feasibility: result });
  } catch (err) {
    return failure(
      state,
      `Feasibility assessment failed: ${getErrorMessage(err)}`,
    );
  }
}
