/**
 * Capability contract definitions.
 */

import type { IncidentResolutionState } from "../orchestration/state";

/**
 * Result returned by every capability.
 */
export type CapabilityResult<T = unknown> = {
  success: boolean;
  state: IncidentResolutionState;
  data?: T;
  error?: string;
  idle?: boolean;
};

/**
 * Capability Configuration Module Interface.
 * Defines the contract for all capability modules.
 */
export type CapabilityConfig = {
  stage: string | ((state: IncidentResolutionState) => string);
  action: string | ((state: IncidentResolutionState) => string);
  logResult: (state: IncidentResolutionState, result: CapabilityResult) => void;
};

/**
 * Standard Capability Handler Interface.
 */
export type CapabilityHandler = (
  state: IncidentResolutionState,
) => Promise<CapabilityResult>;

/**
 * Helper to create a successful capability result.
 */
export function success<T>(
  state: IncidentResolutionState,
  data?: T,
): CapabilityResult<T> {
  return { success: true, state, data };
}

/**
 * Helper to create a failed capability result.
 */
export function failure(
  state: IncidentResolutionState,
  error: string,
): CapabilityResult<never> {
  return { success: false, state, error };
}
