import type { FastifyInstance } from "fastify";
import type { ConfigHealthIssue } from "@nightwarden/shared";
import { requireSession } from "../auth/session.js";
import { checkLLMReadiness, notConfiguredMessage } from "./readiness.js";
import { getFleetView } from "../ws/fleet.js";
import {
  getLokiIntegration,
  getPrometheusIntegration,
} from "../db/integrations.js";
import { getAlertSource } from "../db/alert-sources.js";

// Where each issue is fixed: connecting an evidence source happens on the
// integrations catalog, picking a model in settings.
const INTEGRATIONS_HREF = "/integrations";
const SETTINGS_HREF = "/settings";

// App-wide setup problems, surfaced as a console banner so a misconfiguration is found
// at setup, not at 3am. Advisory except llm-not-configured, which the run gate enforces.
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

      return { issues };
    },
  );
}
