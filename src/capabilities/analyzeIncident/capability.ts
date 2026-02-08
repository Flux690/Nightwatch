/**
 * Analyze error logs to identify infrastructure incidents and their causal relationships.
 */

import type { IncidentResolutionState } from "../../orchestration/state";
import type {
  CapabilityConfig,
  CapabilityHandler,
  CapabilityResult,
} from "../types";
import type { IncidentGraph } from "../../types";
import { success, failure } from "../types";
import { runAgent, AgentTool } from "../../llm/runtime";
import {
  listContainersTool,
  inspectContainerTool,
  listContainersDeclaration,
  inspectContainerDeclaration,
} from "../../tools/docker";
import { loadPrompt } from "../../utils/promptLoader";
import { getErrorMessage } from "../../utils/helpers";
import { logger } from "../../utils/logger";
import schema from "./schema.json";

const SYSTEM_PROMPT = loadPrompt(import.meta.url);

type IncidentGraphAnalysis = {
  nodes: Array<{
    container: string;
    type: string;
    evidence: string[];
    timestamp: string;
  }>;
  edges: Array<{
    from: number;
    to: number;
  }>;
  root: number | null;
  summary: string;
};

export const config: CapabilityConfig = {
  stage: "Analysis",
  action: "Analyzing logs to identify incident graph",
  logResult: (state, result) => {
    if (
      result.success &&
      state.incidentGraph &&
      state.incidentGraph.nodes.length > 0
    ) {
      logger.incidentGraph(state.incidentGraph);
    } else if (result.success) {
      logger.result(true, "No infrastructure incident detected");
    } else {
      logger.result(false, "Analysis failed", {
        Error: result.error ?? "Unknown",
      });
    }
  },
};

export const handler: CapabilityHandler = async (state) => {
  const result = await analyzeIncident(state);
  const idle =
    result.success &&
    (!result.state.incidentGraph ||
      result.state.incidentGraph.nodes.length === 0);
  return { ...result, idle };
};

export async function analyzeIncident(
  state: IncidentResolutionState,
): Promise<CapabilityResult<IncidentGraph | null>> {
  if (!state.logs || state.logs.length === 0) {
    return failure(state, "Cannot analyze: no logs present.");
  }

  if (state.incidentGraph) {
    return failure(state, "Incident graph already identified.");
  }

  const userMessage = `Analyze these logs:\n${state.logs.map((log, i) => `[${i}] ${log}`).join("\n")}`;

  const tools: AgentTool[] = [
    {
      declaration: listContainersDeclaration,
      handler: async () => listContainersTool(),
    },
    {
      declaration: inspectContainerDeclaration,
      handler: async (args) =>
        inspectContainerTool((args as { name: string }).name),
    },
  ];

  try {
    const { result } = await runAgent<IncidentGraphAnalysis>({
      systemInstruction: SYSTEM_PROMPT,
      initialUserMessage: userMessage,
      tools,
      responseSchema: schema,
    });

    // No incident detected
    if (result.root === null || result.nodes.length === 0) {
      return success(state, null);
    }

    const incidentGraph: IncidentGraph = {
      nodes: result.nodes,
      edges: result.edges,
      root: result.root,
      summary: result.summary,
    };

    return success({ ...state, incidentGraph }, incidentGraph);
  } catch (err) {
    return failure(state, `Analysis failed: ${getErrorMessage(err)}`);
  }
}
