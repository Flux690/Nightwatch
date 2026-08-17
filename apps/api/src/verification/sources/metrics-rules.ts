import { listMetricsBackends } from "../../integrations/metrics/backends.js";
import { firingInstancesOf } from "../../integrations/metrics/client.js";
import { logger } from "../../logger.js";
import type { ConditionState, VerificationSource } from "../source.js";

/* The rules API answers for its own alerting rules, on the same evaluation that
   fired the alert - not a query we composed, not a threshold we guessed.

   Which host serves it is configuration, not an assumption: VictoriaMetrics
   serves rules from vmalert alone, Grafana Cloud from the Grafana stack behind
   a different credential, and a Grafana-managed rule lives in Grafana rather
   than in any metrics backend at all. Each connection names its own rules
   endpoint, so all three answer here through one mechanism. */
export const metricsRulesSource: VerificationSource = {
  name: "metrics-rules",

  claims(alert) {
    return (
      alert.alertType !== "unknown" &&
      listMetricsBackends().some((backend) => backend.rules !== null)
    );
  },

  async checkCondition(alert): Promise<ConditionState> {
    /* Every backend with a rules endpoint is asked, because which one holds the
       rule is not knowable from the alert: two clusters can both be connected
       and only one evaluate it. One saying "cleared" is the answer; the rest
       answering "no such rule" is not evidence against it. */
    let cleared = false;
    for (const backend of listMetricsBackends()) {
      if (backend.rules === null) continue;
      try {
        const instances = await firingInstancesOf(
          backend.rules,
          alert.alertType,
        );
        // This backend knows no rule by that name, so it cannot speak to this
        // alert. Silence from one is never a recovery.
        if (instances === null) continue;
        /* Emptiness is the whole answer: no instance of the rule is active, so
           this alert's is not either. Labels are never compared - the alert
           carries the external_labels a rule evaluation has no way to know
           about. A rule still pending counts as firing. */
        if (instances.every((instance) => instance.state === "inactive")) {
          cleared = true;
        } else {
          // One backend that still holds it firing settles it: the condition is
          // true somewhere, so it has not recovered.
          return "unknown";
        }
      } catch (err) {
        logger.warn(
          { err, backend: backend.label, alertType: alert.alertType },
          "verification: a metrics backend could not be asked",
        );
      }
    }
    return cleared ? "cleared" : "unknown";
  },
};
