/**
 * Execute the remediation steps from the validated plan.
 */

import type { IncidentResolutionState } from "../../orchestration/state";
import type {
  CapabilityConfig,
  CapabilityHandler,
  CapabilityResult,
} from "../types";
import type { ExecutionResult } from "../../types";
import { success, failure } from "../types";
import { executeCommands } from "../../execution/executor";
import { logger } from "../../utils/logger";

export type ExecutionData = {
  executionResult: ExecutionResult;
  allSucceeded: boolean;
};

export const config: CapabilityConfig = {
  stage: "Execution",
  action: "Executing remediation commands",
  logResult: (state, result) => {
    if (state.executionResult) {
      logger.execution(state.executionResult);
    } else {
      logger.result(false, "Execution failed", {
        Error: result.error ?? "Unknown",
      });
    }
  },
};

export const handler: CapabilityHandler = async (state) => {
  const result = await executePlan(state);
  return result;
};

export async function executePlan(
  state: IncidentResolutionState,
): Promise<CapabilityResult<ExecutionData>> {
  if (!state.plan) {
    return failure(state, "Cannot execute: no plan exists.");
  }

  if (!state.planValidated) {
    return failure(state, "Cannot execute: plan has not been validated.");
  }

  if (state.plan.steps.length === 0) {
    return failure(state, "Cannot execute: plan has no remediation steps.");
  }

  const result = await executeCommands(state.plan.steps);
  const allSucceeded = result.failedAtStep === -1;

  if (allSucceeded) {
    return success(
      { ...state, executionResult: result },
      { executionResult: result, allSucceeded: true },
    );
  }

  const failedStepResult = result.results[result.failedAtStep];
  const failedStepAction = state.plan.steps[result.failedAtStep].action;
  const output = failedStepResult.stderr || failedStepResult.stdout;

  const updatedState: IncidentResolutionState = {
    ...state,
    executionResult: result,
    failureContext: {
      type: "execution_failed",
      step: failedStepAction,
      reason: `Command failed at step ${result.failedAtStep + 1}`,
      output,
    },
  };

  return failure(
    updatedState,
    `Execution failed at step ${result.failedAtStep + 1}: ${output || failedStepAction}`,
  );
}
