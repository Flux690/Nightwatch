/**
 * State and context definitions for the orchestrator.
 *
 * IncidentResolutionState: Pure data representing where we are in resolving an incident.
 * OrchestrationContext: Runtime tracking, audit log, and LLM memory managed by the loop.
 */

import type { Content } from "@google/genai";
import type {
  IncidentGraph,
  FeasibilityAssessment,
  RemediationPlan,
  ExecutionResult,
  FailureContext,
  Resolution,
  HistoryEntry,
} from "../types";

/**
 * Pure state representing the incident resolution process.
 * Passed to capabilities, returned with updates.
 * Contains only data relevant to the incident being resolved.
 */
export type IncidentResolutionState = Readonly<{
  // Input
  /** Raw error logs that triggered the incident */
  logs: string[] | null;

  // Derived data (populated by capabilities)
  /** Incident graph from analysis - contains nodes, edges, and root cause */
  incidentGraph: IncidentGraph | null;

  /** Feasibility assessment result */
  feasibility: FeasibilityAssessment | null;

  /** Current remediation plan */
  plan: RemediationPlan | null;

  /** Result of executing plan.steps */
  executionResult: ExecutionResult | null;

  /** Result of executing plan.verification */
  verificationResult: ExecutionResult | null;

  /** Why the last attempt failed (consumed by replanning) */
  failureContext: FailureContext | null;

  /** Conversation memory for planner LLM across replanning attempts */
  plannerHistory: Content[];

  // Status flags
  /** Whether current plan has passed validation */
  planValidated: boolean;

  /** Terminal status of the resolution process */
  resolution: Resolution;
}>;

/**
 * Runtime context managed by the orchestrator loop.
 * Not passed to capabilities — internal bookkeeping only.
 */
export type OrchestrationContext = {
  /** Current attempt number (1-indexed) */
  attemptCount: number;

  /** Maximum attempts before forced escalation (from policy) */
  maxAttempts: number;

  /** Audit trail of capability invocations (for humans/debugging) */
  history: HistoryEntry[];

  /** Gemini conversation history for orchestrator (for LLM) */
  orchestratorConversationHistory: Content[];
};

/**
 * Creates initial state when an incident is first observed.
 */
export function createInitialState(logs: string[]): IncidentResolutionState {
  return {
    logs,
    incidentGraph: null,
    feasibility: null,
    plan: null,
    executionResult: null,
    verificationResult: null,
    failureContext: null,
    plannerHistory: [],
    planValidated: false,
    resolution: "pending",
  };
}

/**
 * Creates initial orchestration context.
 */
export function createInitialContext(
  maxAttempts: number,
): OrchestrationContext {
  return {
    attemptCount: 0,
    maxAttempts,
    history: [],
    orchestratorConversationHistory: [],
  };
}
