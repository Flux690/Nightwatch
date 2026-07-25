import type { FastifyInstance } from "fastify";
import type { ConfigHealthIssue } from "@nightwarden/shared";
import { requireSession } from "../auth/session.js";
import { checkLLMReadiness, notConfiguredMessage } from "./readiness.js";
import { decrypt } from "./crypto.js";
import { getFleetView } from "../ws/fleet.js";
import {
  getLokiIntegration,
  getPrometheusIntegration,
} from "../db/integrations.js";
import { getAlertSource } from "../db/alert-sources.js";
import { labelValues } from "../integrations/prometheus.js";
import { logger } from "../logger.js";

// Where each issue is fixed: connecting an evidence source happens on the
// integrations catalog; the server-label problems are fixed on the inbound-alerts
// page, where delivery and identity labels are configured together.
const INTEGRATIONS_HREF = "/integrations";
const ALERTS_HREF = "/integrations/alertmanager";
const SETTINGS_HREF = "/settings";

// App-wide setup problems, surfaced as a console banner so a misconfiguration is found
// at setup, not at 3am. Advisory except llm-not-configured, which the run gate enforces;
// the label check is gated to multi-server because it costs a Prometheus round-trip.
export async function registerConfigHealthRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/config/health",
    { preHandler: requireSession },
    async (): Promise<{ issues: ConfigHealthIssue[] }> => {
      const issues: ConfigHealthIssue[] = [];

      // First among the issues because it blocks everything: without a model no
      // alert can be investigated at all, whatever else is connected.
      const readiness = checkLLMReadiness();
      if (!readiness.ready) {
        issues.push({
          kind: "llm-not-configured",
          message: notConfiguredMessage(readiness.missing),
          href: SETTINGS_HREF,
        });
      }

      const fleet = getFleetView();
      const prometheus = getPrometheusIntegration();
      const loki = getLokiIntegration();

      // An alert source with nothing to investigate with: the ingest 503 is the
      // runtime backstop, but the operator should learn here, not on the first alert.
      const hasEvidence =
        fleet.length > 0 || prometheus !== null || loki !== null;
      if (getAlertSource("alertmanager") !== null && !hasEvidence) {
        issues.push({
          kind: "no-evidence-source",
          message:
            "Alert delivery is set up, but there is no evidence source. Connect a runner, Prometheus, or Loki so investigations can run.",
          href: INTEGRATIONS_HREF,
        });
      }

      // With two or more Docker servers, alerts must carry nw_server to route to the
      // right one. Only meaningful at 2+ servers and when Prometheus is connected to
      // read the labels actually present in the metrics.
      const dockerServers = fleet
        .filter((r) => r.services.some((s) => s.identity.provider === "docker"))
        .map((r) => r.serverName ?? r.hostname)
        .filter((n): n is string => n !== null);
      if (dockerServers.length >= 2 && prometheus !== null) {
        try {
          const observed = await labelValues(
            prometheus.baseUrl,
            prometheus.authHeaderEncrypted
              ? decrypt(prometheus.authHeaderEncrypted)
              : null,
            "nw_server",
          );
          const missing = dockerServers.filter((n) => !observed.includes(n));
          const unknown = observed.filter((v) => !dockerServers.includes(v));
          if (missing.length > 0) {
            issues.push({
              kind: "missing-server-label",
              message: `${missing.length} server${missing.length === 1 ? "" : "s"} (${missing.join(", ")}) have no nw_server label in your metrics, so alerts for them cannot be routed to the right server. Add the nw_server label in Prometheus.`,
              href: ALERTS_HREF,
            });
          }
          if (unknown.length > 0) {
            issues.push({
              kind: "unknown-server-label",
              message: `nw_server value${unknown.length === 1 ? "" : "s"} (${unknown.join(", ")}) match no connected server - likely a typo. Make the label and the server name agree.`,
              href: ALERTS_HREF,
            });
          }
        } catch (err) {
          // Prometheus unreachable at poll time is a connection problem the
          // Prometheus card owns, not a config-health issue to raise here.
          logger.debug({ err }, "config-health label check skipped");
        }
      }

      return { issues };
    },
  );
}
