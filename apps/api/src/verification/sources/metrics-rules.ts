import { listMetricsSources } from "../../integrations/metrics/sources.js";
import { firingInstancesOf } from "../../integrations/metrics/client.js";
import { logger } from "../../logger.js";
import type { ConditionState, VerificationSource } from "../source.js";

/* The rules API answers for its own alerting rules, on the same evaluation that
   fired the alert. Which host serves it is configuration, not an assumption:
   each connection names its own rules endpoint. */
export const metricsRulesSource: VerificationSource = {
  name: "metrics-rules",

  claims(alert) {
    return (
      alert.alertType !== "unknown" &&
      listMetricsSources().some((source) => source.rules !== null)
    );
  },

  async checkCondition(alert): Promise<ConditionState> {
    /* Every source with a rules endpoint is asked: which one holds the rule is not
       knowable from the alert. One saying "cleared" is the answer; the rest
       answering "no such rule" is not evidence against it. */
    let cleared = false;
    for (const source of listMetricsSources()) {
      if (source.rules === null) continue;
      try {
        const instances = await firingInstancesOf(
          source.rules,
          alert.alertType,
        );
        // This source knows no rule by that name, so it cannot speak to this
        // alert. Silence from one is never a recovery.
        if (instances === null) continue;
        /* Emptiness is the whole answer: no instance of the rule is active, so this
           alert's is not either. Labels are never compared - the alert carries
           external_labels a rule evaluation cannot know about. */
        if (instances.every((instance) => instance.state === "inactive")) {
          cleared = true;
        } else {
          // One source that still holds it firing settles it: the condition is
          // true somewhere, so it has not recovered.
          return "unknown";
        }
      } catch (err) {
        logger.warn(
          { err, source: source.label, alertType: alert.alertType },
          "verification: a metrics source could not be asked",
        );
      }
    }
    return cleared ? "cleared" : "unknown";
  },
};
