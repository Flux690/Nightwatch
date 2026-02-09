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
} from "../capabilities";
import type {
  CapabilityConfig,
  CapabilityHandler,
} from "../capabilities/types";
import { policy } from "../policy/policy";
import type { HistoryEntry } from "../types";
import { logger } from "../utils/logger";
import { loadPrompt } from "../utils/promptLoader";
import { getErrorMessage } from "../utils/helpers";
import { resolveEscalation, askPlanApproval } from "../utils/prompts";
import { addFact } from "../infrastructure/knowledge";

const SYSTEM_PROMPT = loadPrompt(import.meta.url, "prompt.md");

export type OrchestratorResult = {
  state: IncidentResolutionState;
  idle: boolean;
};

// Internal capabilities — escalate and requestApproval are handled as special
// cases in the loop (they involve user interaction and need function call args).
// Their handlers are never called directly.

const escalateCapability: {
  config: CapabilityConfig;
  handler: CapabilityHandler;
} = {
  config: {
    stage: "Escalation",
    action: "Requesting human assistance",
    logResult: () => {},
  },
  handler: async () => {
    throw new Error("escalate is handled inline in the orchestration loop");
  },
};

const requestApprovalCapability: {
  config: CapabilityConfig;
  handler: CapabilityHandler;
} = {
  config: {
    stage: "Approval",
    action: "Requesting user approval for plan",
    logResult: () => {},
  },
  handler: async () => {
    throw new Error(
      "requestApproval is handled inline in the orchestration loop",
    );
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
  requestApproval: requestApprovalCapability,
  executePlan,
  verifyPlan,
  escalate: escalateCapability,
  reportFindings: reportFindingsCapability,
};

// Main orchestration
export async function runOrchestrator(
  logs: string[],
): Promise<OrchestratorResult> {
  let state = createInitialState(logs);
  const context = createInitialContext(
    policy.constraints.maxActionsPerIncident,
  );

  const modeInstruction =
    policy.mode === "observe"
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

      const choice = await resolveEscalation(
        `Maximum remediation attempts (${context.maxAttempts}) exhausted.`,
        "Provide additional context about the infrastructure or incident to help the agent try a different approach.",
      );

      if (choice.action === "dismiss") {
        state = { ...state, resolution: "dismissed" };
        break;
      } else {
        addFact("User context after max attempts reached", choice.context);
        context.attemptCount = 0;
        context.orchestratorConversationHistory.push({
          role: "user",
          parts: [
            {
              text: `User provided additional context after max attempts: ${choice.context}. Attempt counter has been reset. Continue resolving the incident with this new information.`,
            },
          ],
        });
        continue;
      }
    }

    // Build user message with current state
    const stateMessage: Content = {
      role: "user",
      parts: [{ text: `Current State:\n${JSON.stringify(state, null, 2)}` }],
    };
    context.orchestratorConversationHistory.push(stateMessage);

    try {
      const allowedTools = getCapabilities(policy.mode);

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

      // === SPECIAL CASE: escalate ===
      if (capabilityName === "escalate") {
        const args = functionCall.args as {
          reason: string;
          needed_context: string;
        };
        const reason = args.reason;
        const neededContext = args.needed_context;

        const choice = await resolveEscalation(reason, neededContext);

        if (choice.action === "dismiss") {
          state = { ...state, resolution: "dismissed" };

          context.history.push({
            timestamp: new Date().toISOString(),
            capability: "escalate",
            success: true,
            summary: "User dismissed the incident",
          });

          context.orchestratorConversationHistory.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "escalate",
                  response: {
                    success: true,
                    action: "dismissed",
                    summary: "User chose to dismiss the incident.",
                  },
                },
              },
            ],
          });
        } else {
          addFact(reason, choice.context);

          // Reset feasibility if it was false (unblock planning path)
          state = {
            ...state,
            ...(state.feasibility && !state.feasibility.feasible
              ? { feasibility: null }
              : {}),
            failureContext: null,
          };

          context.history.push({
            timestamp: new Date().toISOString(),
            capability: "escalate",
            success: true,
            summary: `User provided context: ${choice.context}`,
          });

          context.orchestratorConversationHistory.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "escalate",
                  response: {
                    success: true,
                    action: "continue",
                    userContext: choice.context,
                    summary:
                      "User provided additional context. Feasibility has been reset if it was false. failureContext has been cleared. Re-evaluate the situation with this new information.",
                  },
                },
              },
            ],
          });
        }

        continue;
      }

      // === SPECIAL CASE: requestApproval ===
      if (capabilityName === "requestApproval") {
        const choice = await askPlanApproval();

        if (choice.action === "approve") {
          logger.result(true, "Plan approved by user");

          context.history.push({
            timestamp: new Date().toISOString(),
            capability: "requestApproval",
            success: true,
            summary: "User approved the plan",
          });

          context.orchestratorConversationHistory.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "requestApproval",
                  response: {
                    success: true,
                    approved: true,
                    summary: "User approved the plan. Proceed to executePlan.",
                  },
                },
              },
            ],
          });
        } else {
          if (state.plan) {
            logger.planGrayOut(state.plan);
          }
          logger.result(false, "Plan rejected by user", {
            Feedback: choice.feedback,
          });

          state = {
            ...state,
            failureContext: {
              type: "user_rejected",
              reason: choice.feedback,
            },
            planValidated: false,
            executionResult: null,
            verificationResult: null,
          };

          context.history.push({
            timestamp: new Date().toISOString(),
            capability: "requestApproval",
            success: false,
            summary: `User rejected: ${choice.feedback}`,
          });

          context.orchestratorConversationHistory.push({
            role: "user",
            parts: [
              {
                functionResponse: {
                  name: "requestApproval",
                  response: {
                    success: false,
                    approved: false,
                    feedback: choice.feedback,
                    summary: `User rejected the plan. Feedback: "${choice.feedback}". Use planRemediation to create a revised plan addressing this feedback.`,
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

      const result = await capability.handler(state);
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

  return { state, idle: false };
}
