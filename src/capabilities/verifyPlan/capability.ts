/**
 * Verify that the remediation resolved the incident.
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

export type VerificationData = {
  verificationResult: ExecutionResult;
  verified: boolean;
};

export const config: CapabilityConfig = {
  stage: "Verification",
  action: "Verifying remediation effectiveness",
  logResult: (state, result) => {
    if (state.verificationResult) {
      logger.verification(state.verificationResult);
    } else {
      logger.result(false, "Verification failed", {
        Error: result.error ?? "Unknown",
      });
    }
  },
};

export const handler: CapabilityHandler = async (state) => {
  const result = await verifyPlan(state);
  return result;
};

export async function verifyPlan(
  state: IncidentResolutionState,
): Promise<CapabilityResult<VerificationData>> {
  if (!state.plan) {
    return failure(state, "Cannot verify: no plan exists.");
  }

  if (!state.executionResult) {
    return failure(state, "Cannot verify: execution has not been performed.");
  }

  if (state.executionResult.failedAtStep !== -1) {
    return failure(
      state,
      "Cannot verify: execution failed. Replanning required.",
    );
  }

  if (state.plan.verification.length === 0) {
    const emptyResult: ExecutionResult = { results: [], failedAtStep: -1 };
    return success(
      { ...state, verificationResult: emptyResult, resolution: "resolved" },
      { verificationResult: emptyResult, verified: true },
    );
  }

  const result = await executeCommands(state.plan.verification);
  const verified = result.failedAtStep === -1;

  if (verified) {
    return success(
      { ...state, verificationResult: result, resolution: "resolved" },
      { verificationResult: result, verified: true },
    );
  }

  const failedStepResult = result.results[result.failedAtStep];
  const failedStepAction = state.plan.verification[result.failedAtStep].action;
  const output = failedStepResult.stderr || failedStepResult.stdout;

  const updatedState: IncidentResolutionState = {
    ...state,
    verificationResult: result,
    failureContext: {
      type: "verification_failed",
      step: failedStepAction,
      reason: `Verification failed at step ${result.failedAtStep + 1}`,
      output,
    },
  };

  return failure(
    updatedState,
    `Verification failed at step ${result.failedAtStep + 1}: ${output || failedStepAction}`,
  );
}
