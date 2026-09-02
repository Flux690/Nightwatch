import { getMetricsSource } from "../../integrations/metrics/sources.js";
import { firingInstancesOf } from "../../integrations/metrics/client.js";
import { logger } from "../../logger.js";
import type { ConditionState, VerificationSource } from "../source.js";

/* The rules API answers on the same evaluation that fired the alert. Which host
   serves it is configuration: the connection names its own rules endpoint. */
export const metricsRulesSource: VerificationSource = {
  name: "metrics-rules",

  async claims(alert) {
    return (
      alert.alertType !== "unknown" && (await getMetricsSource())?.rules != null
    );
  },

  async checkCondition(alert): Promise<ConditionState> {
    const rules = (await getMetricsSource())?.rules;
    if (rules == null) return "unknown";
    try {
      const instances = await firingInstancesOf(rules, alert.alertType);
      // The source knows no rule by that name, so it cannot speak to this
      // alert. Silence is never a recovery.
      if (instances === null) return "unknown";
      /* Emptiness is the whole answer: no instance of the rule is active. Labels
         are never compared, since the alert carries external_labels rules lack. */
      return instances.every((instance) => instance.state === "inactive")
        ? "cleared"
        : "unknown";
    } catch (err) {
      logger.warn(
        { err, alertType: alert.alertType },
        "verification: the metrics source could not be asked",
      );
      return "unknown";
    }
  },
};
