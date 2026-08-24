// Vocabulary both platforms share, so no type has to branch on platform.
// Anything describing a container or workload lives in its own file.
export type RiskLevel = "low" | "medium" | "high";

// An identity that resolved to nothing actionable. Propagated verbatim, so "not
// running" is a finding the agent reasons about, not an exception. Each resolver
// builds its own in its own vocabulary - there is no shared constructor.
export interface NotFoundResult {
  found: false;
  reason: string;
}

// One runner's answer inside a fan-out.
export interface RunnerScopedResult<T> {
  runner: string;
  result: T;
}

// A runner-routed command's result, always enveloped even for a single runner, so
// the model and the console each have exactly one shape to read.
export interface FleetResult<T> {
  byRunner: Array<RunnerScopedResult<T>>;
  runnersOmitted?: number;
}
