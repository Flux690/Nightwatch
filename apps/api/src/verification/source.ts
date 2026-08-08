import type { NormalizedAlert } from "@nightwarden/shared";

/* Who can answer whether an alert's condition is still true.

   Verification never asks the model. The agent chooses which metric to look at
   and how to read it, and a fix that improves the number it happened to pick can
   still leave the condition that fired firing. So the oracle is the alert's own
   condition, re-evaluated by whatever system owns it.

   One implementation per integration that can answer. The system stays correct
   with none: an alert source reporting recovery on its own - Alertmanager's
   resolved webhook - is the passive path, and a source here is a cross-check on
   top of it rather than a dependency. */
export interface VerificationSource {
  // Named for the log, so an operator can see which source answered.
  readonly name: string;
  // Whether this source owns the alert at all. False is not an opinion about
  // the condition.
  claims(alert: NormalizedAlert): boolean;
  // true = still firing, false = the condition is false.
  //
  // `null` is the load-bearing value: "I cannot answer". Unreachable, rule
  // renamed, integration disconnected. It must never collapse into false, or a
  // missing integration silently reads as recovery - which is the exact failure
  // this whole mechanism exists to prevent.
  stillFiring(alert: NormalizedAlert): Promise<boolean | null>;
}
