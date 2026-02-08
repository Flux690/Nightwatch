/**
 * Core domain types for Nightwatch incident resolution.
 * These types represent the data structures that flow through the system.
 */

/** Single node in an incident graph representing one affected component */
export type IncidentNode = {
  container: string;
  type: string; // "storage.cache.oom_killed"
  evidence: string[];
  timestamp: string;
};

/** Causal link between incident nodes */
export type CausalLink = {
  from: number; // Array index of cause node
  to: number; // Array index of effect node
};

/** Graph of related incidents with causal relationships */
export type IncidentGraph = {
  nodes: IncidentNode[];
  edges: CausalLink[];
  root: number | null; // Array index of root cause node, or null if no incident
  summary: string; // High-level incident summary
};

/** Feasibility assessment for remediation */
export type FeasibilityAssessment = {
  feasible: boolean;
  summary: string;
  blocking_reason: string | null;
};

/** Single step in a remediation or verification plan */
export type PlanStep = {
  action: string;
  reason: string;
};

/** Complete remediation plan with verification */
export type RemediationPlan = {
  summary: string;
  steps: PlanStep[];
  verification: PlanStep[];
};

/** Result of executing a single command */
export type StepResult = {
  step: string;
  status: "success" | "failure";
  exitCode: number;
  stdout: string;
  stderr: string;
  timestamp: string;
};

/** Result of executing a sequence of commands */
export type ExecutionResult = {
  results: StepResult[];
  failedAtStep: number; // -1 if all succeeded, 0-indexed otherwise
};

/** Context about why an attempt failed, used for replanning */
export type FailureContext = {
  type:
    | "remediation_command_rejected"
    | "verification_command_rejected"
    | "execution_failed"
    | "verification_failed"
    | "user_rejected";
  step?: string;
  reason?: string;
  output?: string;
};

/** How the incident resolution ended */
export type Resolution = "pending" | "resolved" | "observed" | "dismissed";

/** Entry in the orchestration audit history */
export type HistoryEntry = {
  timestamp: string;
  capability: string;
  success: boolean;
  summary: string;
};
