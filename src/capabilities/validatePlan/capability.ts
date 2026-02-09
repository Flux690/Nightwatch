/**
 * Validate that all commands in the remediation plan are safe to execute.
 */

import type { IncidentResolutionState } from "../../orchestration/state";
import type {
  CapabilityConfig,
  CapabilityHandler,
  CapabilityResult,
} from "../types";
import { success, failure } from "../types";
import {
  assertCommandsValid,
  CommandValidationError,
} from "../../execution/validator";
import { infrastructure } from "../../infrastructure/compose";
import { logger } from "../../utils/logger";

export type ValidationData = {
  valid: boolean;
  checkedSteps: number;
  checkedVerification: number;
};

export const config: CapabilityConfig = {
  stage: "Validation",
  action: "Validating command safety",
  logResult: (state, result) => {
    if (result.success) {
      logger.result(true, "All commands validated as safe");
    } else {
      if (state.plan) {
        logger.planGrayOut(state.plan);
      }
      logger.result(false, "Plan validation failed", {
        "Rejection Reason": result.error ?? "Unknown",
      });
    }
  },
};

export const handler: CapabilityHandler = async (state) => {
  const result = await validatePlan(state);
  return result;
};

export function validatePlan(
  state: IncidentResolutionState,
): CapabilityResult<ValidationData> {
  if (!state.plan) {
    return failure(state, "Cannot validate: no plan exists.");
  }

  if (state.planValidated) {
    return failure(state, "Plan is already validated.");
  }

  const knownContainers = infrastructure.containers;

  try {
    assertCommandsValid(state.plan.steps, knownContainers);
    assertCommandsValid(state.plan.verification, knownContainers);

    return success(
      { ...state, planValidated: true },
      {
        valid: true,
        checkedSteps: state.plan.steps.length,
        checkedVerification: state.plan.verification.length,
      },
    );
  } catch (err) {
    if (err instanceof CommandValidationError) {
      const isVerificationCommand = state.plan.verification.some(
        (v) => v.action === err.command,
      );

      const updatedState: IncidentResolutionState = {
        ...state,
        failureContext: {
          type: isVerificationCommand
            ? "verification_command_rejected"
            : "remediation_command_rejected",
          step: err.command,
          reason: err.reason,
        },
      };

      return failure(
        updatedState,
        `Validation failed: ${err.reason} (command: ${err.command})`,
      );
    }
    throw err;
  }
}
