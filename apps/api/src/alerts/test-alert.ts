import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ServiceIdentity } from "@nightwatch/shared";
import { requireSession } from "../auth/session.js";
import { getFleetView } from "../ws/fleet.js";
import { parseAlertmanager } from "./parsers/alertmanager.js";
import { routeAlert } from "./route-alert.js";

// Rebuild the labels an advertised identity would arrive with, so the verify alert runs
// through the same deriveServiceIdentity path real alerts do (else a broken parser still passes).
function identityToLabels(identity: ServiceIdentity): Record<string, string> {
  const base = { alertname: "NightwatchVerify", severity: "info" };
  if (identity.provider === "docker") {
    return {
      ...base,
      "com.docker.compose.project": identity.project,
      "com.docker.compose.service": identity.service,
      ...(identity.server ? { server: identity.server } : {}),
    };
  }
  return {
    ...base,
    namespace: identity.namespace,
    deployment: identity.workload,
    ...(identity.cluster ? { cluster: identity.cluster } : {}),
  };
}

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

      const target = fleetRunner.services[0]?.identity;
      if (!target) {
        return reply.code(200).send({
          error: "runner advertises no services yet - nothing to route-test",
        });
      }

      const parsed = parseAlertmanager({
        alerts: [
          {
            status: "firing",
            labels: identityToLabels(target),
            annotations: { summary: "Nightwatch verify" },
            startsAt: new Date().toISOString(),
            endsAt: "0001-01-01T00:00:00Z",
            fingerprint: `verify-${randomUUID()}`,
          },
        ],
      });
      const alert = parsed[0];
      if (!alert) {
        return reply
          .code(200)
          .send({ error: "verify alert failed to parse - platform bug" });
      }

      const status = routeAlert(alert);
      return reply.code(200).send({
        ok: true,
        status,
        runnerId: fleetRunner.runnerId,
        server: fleetRunner.serverName ?? fleetRunner.hostname,
      });
    },
  );
}
