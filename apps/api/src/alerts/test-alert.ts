import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { NormalizedAlert } from "@nightwatch/shared";
import { requireSession } from "../auth/session.js";
import { getFleetView } from "../ws/router.js";
import { routeAlert } from "./route-alert.js";

const PLACEHOLDER_IDENTITY: NormalizedAlert["targetIdentifier"] = {
  provider: "docker",
  project: "nightwatch-verify",
  service: "nightwatch-verify",
};

// Session-gated rather than token-gated: this is a connectivity check the
// operator triggers by hand, not a new alert source.
export async function registerAlertTestRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body: { runnerId?: string } }>(
    "/alerts/test",
    { preHandler: requireSession },
    async (request, reply) => {
      const runnerId = request.body?.runnerId;
      if (!runnerId) {
        return reply.code(400).send({ error: "runnerId is required" });
      }

      const fleetRunner = getFleetView().find((r) => r.runnerId === runnerId);
      if (!fleetRunner || !fleetRunner.online) {
        return reply.code(404).send({
          error: "runner not connected - verify after it comes online",
        });
      }

      const alert: NormalizedAlert = {
        sourceAlertId: `verify-${randomUUID()}`,
        runnerId: fleetRunner.runnerId,
        hostname: fleetRunner.hostname,
        targetIdentifier:
          fleetRunner.services[0]?.identity ?? PLACEHOLDER_IDENTITY,
        alertType: "NightwatchVerify",
        severity: "info",
        firedAt: new Date().toISOString(),
        rawPayload: { source: "add-server-wizard-verify" },
      };

      const status = routeAlert(alert);
      return reply.code(200).send({
        ok: true,
        status,
        runnerId: fleetRunner.runnerId,
        hostname: fleetRunner.hostname,
      });
    },
  );
}
