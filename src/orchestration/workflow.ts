/**
 * Main orchestrator loop.
 *
 * This is the "brain" of Nightwatch. It:
 * 1. Receives initial state from observation layer
 * 2. Asks Gemini which capability to invoke
 * 3. Executes that capability
 * 4. Updates state with result
 * 5. Repeats until resolution, dismissal, or idle
 */

import type { Content } from "@google/genai";
import { FunctionCallingConfigMode, ThinkingLevel } from "@google/genai";
import { withRetry } from "../utils/helpers";
import { gemini } from "../llm/model";
import {
  IncidentResolutionState,
  createInitialState,
  createInitialContext,
} from "./state";
import { getCapabilities, CapabilityName } from "./registry";
import {
  analyzeIncident,
  assessFeasibility,
  planRemediation,
  validatePlan,
  executePlan,
  verifyPlan,
  success,
} from "../capabilities/index";
import type {
  CapabilityConfig,
  CapabilityHandler,
} from "../capabilities/types";
import { getConfig, getInfrastructure } from "../globals";
import type { HistoryEntry } from "../types";
import { logger } from "../utils/logger";
import { loadPrompt } from "../utils/promptLoader";
import { getErrorMessage } from "../utils/helpers";
import { showPrompt, type ConsultType } from "../utils/formInput";
import { addFact } from "../llm/knowledge";
import { cleanHistory } from "../llm/runtime";
import { addResolved } from "./resolvedStore";

const SYSTEM_PROMPT = loadPrompt(import.meta.url, "prompt.md");

export type OrchestratorResult = {
  state: IncidentResolutionState;
  idle: boolean;
};

// Internal capabilities — consultUser is handled as a special case in the loop
// (it involves user interaction and needs function call args).

const consultUserCapability: {
  config: CapabilityConfig;
  handler: CapabilityHandler;
} = {
  config: {
    stage: "User Consultation",
    action: "Requesting user input",
    logResult: () => {},
  },
  handler: async () => {
    throw new Error("consultUser is handled inline in the orchestration loop");
  },
};

const reportFindingsCapability: {
  config: CapabilityConfig;
  handler: CapabilityHandler;
} = {
  config: {
    stage: "Report",
    action: "Recording diagnostic findings",
    logResult: (state) => {
      const feasibleStatus =
        state.feasibility?.feasible === true
          ? "Yes"
          : state.feasibility?.feasible === false
            ? "No"
            : "Not assessed";

      // Get root node type from incident graph if available
      const rootNode =
        state.incidentGraph?.root != null
          ? state.incidentGraph.nodes[state.incidentGraph.root]
          : undefined;

      logger.result(true, "Observation complete", {
        "Incident Type": rootNode?.type ?? "No incident identified",
        "Remediation Feasible": feasibleStatus,
        Summary:
          state.feasibility?.summary ??
          state.incidentGraph?.summary ??
          "No diagnostic findings",
      });
    },
  },
  handler: async (state) => {
    return success({ ...state, resolution: "observed" });
  },
};

// Registry of all capabilities (external + internal)
const CAPABILITY_REGISTRY: Record<
  CapabilityName,
  { config: CapabilityConfig; handler: CapabilityHandler }
> = {
  analyzeIncident,
  assessFeasibility,
  planRemediation,
  validatePlan,
  consultUser: consultUserCapability,
  executePlan,
  verifyPlan,
  reportFindings: reportFindingsCapability,
};

// Main orchestration
export async function runOrchestrator(
  logs: string[],
): Promise<OrchestratorResult> {
  let state = createInitialState(logs);
  const nightwatchConfig = getConfig();
  const context = createInitialContext(nightwatchConfig.maxRetries);

  const modeInstruction =
    nightwatchConfig.mode === "observe"
      ? `\n\nRUNTIME MODE: OBSERVE\nGoal: Diagnose the incident and report findings.\nConstraint: Planning and execution tools are unavailable.`
      : `\n\nRUNTIME MODE: REMEDIATE\nGoal: Resolve the incident using planning and execution tools.`;

  const effectiveSystemPrompt = SYSTEM_PROMPT + modeInstruction;

  while (state.resolution === "pending") {
    // Circuit breaker — routes through user interaction instead of hard-terminating
    if (context.attemptCount >= context.maxAttempts) {
      logger.stage("Circuit Breaker");
      logger.result(false, "Maximum attempts reached", {
        "Attempts Made": context.attemptCount,
        "Attempt Limit": context.maxAttempts,
      });

      logger.consultPrompt(
        `Maximum remediation attempts (${context.maxAttempts}) exhausted.`,
      );
      const choice = await showPrompt("escalation");

      if (choice.action === "dismiss") {
        state = { ...state, resolution: "dismissed" };
        break;
      } else if (choice.action === "text") {
        addFact(getInfrastructure().basePath, "User context after max attempts reached", choice.value);
        context.attemptCount = 0;
        context.orchestratorConversationHistory.push({
          role: "user",
          parts: [
            {
              text: `User provided additional context after max attempts: ${choice.value}. Attempt counter has been reset. Continue resolving the incident with this new information.`,
            },
          ],
        });
        continue;
      }
    }

    // Build user message with current state (exclude sharedHistory — only used by capability agents)
    const { sharedHistory: _, ...stateForOrchestrator } = state;
    const stateMessage: Content = {
      role: "user",
      parts: [{ text: `Current State:\n${JSON.stringify(stateForOrchestrator, null, 2)}` }],
    };
    context.orchestratorConversationHistory.push(stateMessage);

    try {
      const allowedTools = getCapabilities(nightwatchConfig.mode);

      const response = await withRetry(() =>
        gemini.models.generateContent({
          model: "gemini-3-pro-preview",
          contents: context.orchestratorConversationHistory,
          config: {
            systemInstruction: effectiveSystemPrompt,
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.HIGH,
              includeThoughts: true,
            },
            tools: [{ functionDeclarations: allowedTools }],
            toolConfig: {
              functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
            },
          },
        }),
      );

      const modelContent = response.candidates?.[0]?.content;
      if (!modelContent?.parts) {
        throw new Error("Empty response from orchestrator");
      }
      context.orchestratorConversationHistory.push(modelContent);

      // Check for function call
      const functionCall = response.functionCalls?.[0];
      if (!functionCall) {
        context.orchestratorConversationHistory.push({
          role: "user",
          parts: [
            {
              text: "You must select a capability to invoke. Choose one of the available tools.",
            },
          ],
        });
        continue;
      }

      const capabilityName = functionCall.name as CapabilityName;
      const capability = CAPABILITY_REGISTRY[capabilityName];

      if (!capability) {
        throw new Error(`Unknown capability: ${capabilityName}`);
      }

      const { config } = capability;

      // Log stage and action (resolve dynamic strings if needed)
      const stageName =
        typeof config.stage === "function" ? config.stage(state) : config.stage;
      const actionName =
        typeof config.action === "function"
          ? config.action(state)
          : config.action;

      logger.stage(stageName);
      logger.action(actionName);

      // === SPECIAL CASE: consultUser ===
      if (capabilityName === "consultUser") {
        const args = functionCall.args as {
          type: ConsultType;
          reason: string;
          question?: string;
        };

        logger.consultPrompt(args.reason, args.question);
        const choice = await showPrompt(args.type);

        if (choice.action === "dismiss") {
          state = { ...state, resolution: "dismissed" };
          context.history.push({
            timestamp: new Date().toISOString(),
            capability: "consultUser",
            success: true,
            summary: "User dismissed the incident",
          });
          context.orchestratorConversationHistory.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "consultUser",
                  response: { action: "dismissed" },
                },
              },
            ],
          });
        } else if (choice.action === "approve") {
          state = { ...state, approved: true };
          logger.result(true, "Plan approved by user");
          context.history.push({
            timestamp: new Date().toISOString(),
            capability: "consultUser",
            success: true,
            summary: "User approved the plan",
          });
          context.orchestratorConversationHistory.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "consultUser",
                  response: {
                    approved: true,
                    summary: "User approved the plan.",
                  },
                },
              },
            ],
          });
        } else {
          // choice.action === "text"
          const userText = choice.value;

          // Persist to knowledge if it was a question
          if (args.type === "missing_context" && args.question) {
            addFact(getInfrastructure().basePath, args.question, userText);
          }

          // If plan feedback, set failureContext and gray out plan
          if (args.type === "plan_approval") {
            logger.planGrayOut();
            logger.result(false, "Plan rejected by user", {
              Feedback: userText,
            });
            state = {
              ...state,
              failureContext: { type: "user_rejected", reason: userText },
              planValidated: false,
              approved: false,
              executionResult: null,
              verificationResult: null,
            };
          }

          // If escalation context or missing_context answer, reset feasibility if it was false
          if (args.type === "escalation" || args.type === "missing_context") {
            addFact(getInfrastructure().basePath, args.reason, userText);
            state = {
              ...state,
              ...(state.feasibility && !state.feasibility.feasible
                ? { feasibility: null }
                : {}),
              failureContext: null,
              approved: false,
            };
          }

          context.history.push({
            timestamp: new Date().toISOString(),
            capability: "consultUser",
            success: true,
            summary: `User provided: ${userText}`,
          });
          context.orchestratorConversationHistory.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "consultUser",
                  response: {
                    action: "user_provided_text",
                    text: userText,
                    summary:
                      args.type === "plan_approval"
                        ? `User rejected the plan. Feedback: "${userText}".`
                        : `User response: "${userText}".`,
                  },
                },
              },
            ],
          });
        }

        continue;
      }

      // === GENERIC PATH: all other capabilities ===
      const hadFailureContext = state.failureContext !== null;

      const result = await capability.handler(state, context.toolCache);
      const idle = result.idle;

      // Log result
      config.logResult(result.state, result);

      // Check for idle state
      if (idle) {
        return { state: result.state, idle: true };
      }

      const finalState = result.state;

      // Record in audit history
      const historyEntry: HistoryEntry = {
        timestamp: new Date().toISOString(),
        capability: capabilityName,
        success: result.success,
        summary: result.success
          ? "Completed successfully"
          : (result.error ?? "Unknown error"),
      };
      context.history.push(historyEntry);

      // Add function response to Gemini conversation
      context.orchestratorConversationHistory.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: capabilityName,
              response: {
                success: result.success,
                error: result.error,
                summary: historyEntry.summary,
              },
            },
          },
        ],
      });

      // Update state
      state = finalState;

      // Clean shared history after LLM capabilities to strip thinking traces
      if (
        capabilityName === "analyzeIncident" ||
        capabilityName === "assessFeasibility" ||
        capabilityName === "planRemediation"
      ) {
        state = { ...state, sharedHistory: cleanHistory(state.sharedHistory) };
      }

      // Invalidate tool cache after execution mutations
      if (capabilityName === "executePlan") {
        context.toolCache.invalidate();
      }

      // Track attempts - only count replans (planRemediation with prior failure)
      if (capabilityName === "planRemediation" && hadFailureContext) {
        context.attemptCount++;
      }
    } catch (err) {
      logger.result(false, "Unexpected orchestration error", {
        Error: getErrorMessage(err),
      });
      context.orchestratorConversationHistory.push({
        role: "user",
        parts: [
          {
            text: `Error occurred: ${getErrorMessage(err)}. Please select a capability to continue.`,
          },
        ],
      });
    }
  }

  // Record resolved incidents for deduplication
  if (state.resolution === "resolved" && state.incidentGraph) {
    const rootNode =
      state.incidentGraph.root !== null
        ? state.incidentGraph.nodes[state.incidentGraph.root]
        : null;
    addResolved({
      rootContainer: rootNode?.container ?? "unknown",
      incidentSummary: state.incidentGraph.summary,
      resolution: state.plan?.summary ?? "Resolved",
      resolvedAt: Date.now(),
    });
  }

  return { state, idle: false };
}
