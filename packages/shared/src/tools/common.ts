// Vocabulary both platforms share. Everything that describes a container or a
// workload lives in docker.ts or kubernetes.ts; only what is genuinely common to
// both is here, so no type has to branch on platform.

// Approval vocabulary: what a write tool declares about the change it wants.
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
