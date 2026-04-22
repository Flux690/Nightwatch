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
import { runAgent } from "../../llm/runtime";
import { createDiagnosticTools } from "../../tools/docker";
import type { ToolCache } from "../../tools/cache";
import { getResolvedIncidents } from "../../orchestration/resolvedStore";
import { loadPrompt } from "../../utils/promptLoader";
import { getErrorMessage } from "../../utils/helpers";
import { logger } from "../../utils/logger";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(path.join(__dirname, "schema.json"), "utf-8"));

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

export const handler: CapabilityHandler = async (state, toolCache) => {
  const result = await analyzeIncident(state, toolCache);
  const idle =
    result.success &&
    (!result.state.incidentGraph ||
      result.state.incidentGraph.nodes.length === 0);
  return { ...result, idle };
};

export async function analyzeIncident(
  state: IncidentResolutionState,
  toolCache?: ToolCache,
): Promise<CapabilityResult<IncidentGraph | null>> {
  if (!state.logs || state.logs.length === 0) {
    return failure(state, "Cannot analyze: no logs present.");
  }

  if (state.incidentGraph) {
    return failure(state, "Incident graph already identified.");
  }

  let userMessage = `Analyze these logs:\n${state.logs.map((log, i) => `[${i}] ${log}`).join("\n")}`;

  // Append recently resolved incidents for deduplication
  const resolved = getResolvedIncidents();
  if (resolved.length > 0) {
    const lines = resolved.map(
      (r) => `- Container: ${r.rootContainer} | Summary: ${r.incidentSummary} | Resolution: ${r.resolution}`,
    );
    userMessage += `\n\n## Recently Resolved Incidents (last 5 minutes)\n${lines.join("\n")}\nIf current logs match a recently resolved incident, return empty graph.`;
  }

  const tools = createDiagnosticTools(toolCache);

  try {
    const { result, conversationHistory } = await runAgent<IncidentGraphAnalysis>({
      systemInstruction: SYSTEM_PROMPT,
      initialUserMessage: userMessage,
      tools,
      conversationHistory: state.sharedHistory,
      responseSchema: schema,
    });

    // No incident detected
    if (result.root === null || result.nodes.length === 0) {
      return success({ ...state, sharedHistory: conversationHistory }, null);
    }

    const incidentGraph: IncidentGraph = {
      nodes: result.nodes,
      edges: result.edges,
      root: result.root,
      summary: result.summary,
    };

    return success({ ...state, incidentGraph, sharedHistory: conversationHistory }, incidentGraph);
  } catch (err) {
    return failure(state, `Analysis failed: ${getErrorMessage(err)}`);
  }
}
