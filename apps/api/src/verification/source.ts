import type { NormalizedAlert } from "@nightwarden/shared";

// `unknown` must never collapse into `cleared`: a source that cannot answer
// would otherwise read as recovery, the failure this whole mechanism prevents.
export type ConditionState = "cleared" | "unknown";

/* Who can answer whether an alert's condition is still true. Never the model: a
   fix that improves the metric the agent happened to pick can leave the
   condition firing, so the oracle is the condition, re-evaluated by its owner. */
export interface VerificationSource {
  // Named for the log, so a user can see which source answered.
  readonly name: string;
  // Whether this source owns the alert. False is no opinion about the condition.
  claims(alert: NormalizedAlert): boolean;
  checkCondition(alert: NormalizedAlert): Promise<ConditionState>;
}
