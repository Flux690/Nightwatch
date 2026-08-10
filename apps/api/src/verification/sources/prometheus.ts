import { getPrometheusIntegration } from "../../db/integrations.js";
import { firingInstancesOf } from "../../integrations/prometheus.js";
import { logger } from "../../logger.js";
import { decrypt } from "../../secrets.js";
import type { ConditionState, VerificationSource } from "../source.js";

/* Prometheus answers for its own alerting rules, on the same evaluation that
   fired the alert - not a query we composed, not a threshold we guessed. */
export const prometheusSource: VerificationSource = {
  name: "prometheus",

  claims(alert) {
    return getPrometheusIntegration() !== null && alert.alertType !== "unknown";
  },

  async checkCondition(alert): Promise<ConditionState> {
    const integration = getPrometheusIntegration();
    if (integration === null) return "unknown";
    try {
      const instances = await firingInstancesOf(
        integration.baseUrl,
        integration.authHeaderEncrypted
          ? decrypt(integration.authHeaderEncrypted)
          : null,
        alert.alertType,
      );
      // Prometheus knows no rule by that name, so it cannot speak to this alert.
      if (instances === null) return "unknown";
      /* Emptiness is the whole answer: no instance of the rule is active, so this
         alert's is not either. Labels are never compared - the alert carries the
         external_labels a rule evaluation has no way to know about. */
      return instances.every((instance) => instance.state === "inactive")
        ? "cleared"
        : "unknown";
    } catch (err) {
      logger.warn(
        { err, alertType: alert.alertType },
        "verification: Prometheus could not be asked",
      );
      return "unknown";
    }
  },
};
