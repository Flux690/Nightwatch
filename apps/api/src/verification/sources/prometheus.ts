import type { NormalizedAlert } from "@nightwarden/shared";
import { getPrometheusIntegration } from "../../db/integrations.js";
import { firingInstancesOf } from "../../integrations/prometheus.js";
import { logger } from "../../logger.js";
import { decrypt } from "../../secrets.js";
import type { VerificationSource } from "../source.js";

// Labels Prometheus attaches to every instance of a rule rather than to the
// series under it, so matching on them would match any instance of the rule.
const RULE_LABELS = new Set(["alertname", "severity"]);

/* Does the alert we hold match this firing instance? The alert's own labels are
   the identity: they came from this rule's evaluation, so an instance carrying
   all of them is the same series firing again. Compared as a subset because
   Alertmanager adds labels of its own on the way through, and a strict equality
   would read every alert as recovered. */
function sameInstance(
  alert: NormalizedAlert,
  instanceLabels: Record<string, string>,
): boolean {
  const identifying = Object.entries(alert.labels).filter(
    ([key]) => !RULE_LABELS.has(key),
  );
  // Nothing but the rule's own labels: the rule fires for one thing, so any
  // instance of it is that thing.
  if (identifying.length === 0) return true;
  return identifying.every(([key, value]) => instanceLabels[key] === value);
}

/* Prometheus answers for its own alerting rules. It is asked whether the rule
   still holds an instance matching this alert, which is the same evaluation that
   fired it - not a query we composed, and not a threshold we guessed. */
export const prometheusSource: VerificationSource = {
  name: "prometheus",

  claims(alert) {
    return getPrometheusIntegration() !== null && alert.alertType !== "unknown";
  },

  async stillFiring(alert) {
    const integration = getPrometheusIntegration();
    if (integration === null) return null;
    try {
      const instances = await firingInstancesOf(
        integration.baseUrl,
        integration.authHeaderEncrypted
          ? decrypt(integration.authHeaderEncrypted)
          : null,
        alert.alertType,
      );
      // Prometheus knows no rule by that name, so it cannot speak to this alert
      // at all. Silence, not recovery.
      if (instances === null) return null;
      // "pending" is the rule true but not yet for long enough to fire. It is
      // not recovery, and calling it one would resolve an incident that is on
      // its way back.
      return instances.some(
        (instance) =>
          instance.state !== "inactive" && sameInstance(alert, instance.labels),
      );
    } catch (err) {
      logger.warn(
        { err, alertType: alert.alertType },
        "verification: Prometheus could not be asked",
      );
      return null;
    }
  },
};
