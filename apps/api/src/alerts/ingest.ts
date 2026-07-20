import type { FastifyInstance } from "fastify";
import { serviceIdentityKey } from "@nightwatch/shared";
import { parseAlertmanager, type ParsedAlert } from "./parsers/alertmanager.js";
import { routeAlert } from "./route-alert.js";
import {
  findAlertSourceKindByToken,
  setAlertSourceReceived,
} from "../db/alert-sources.js";
import {
  getLokiIntegration,
  getPrometheusIntegration,
} from "../db/integrations.js";
import { extractBearerToken } from "../auth/bearer.js";
import { getFleetView } from "../ws/fleet.js";

export async function registerAlertRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body: unknown }>("/alerts/ingest", async (request, reply) => {
    const plaintext = extractToken(request.headers);

    if (!plaintext) {
      return reply.code(401).send({
        error: "X-Nightwatch-Token or Authorization: Bearer token required",
      });
    }

    const sourceKind = findAlertSourceKindByToken(plaintext);
    if (sourceKind === null) {
      return reply.code(401).send({ error: "unknown or revoked token" });
    }

    let parsed: ParsedAlert[];
    try {
      parsed = parseSource(request.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }

    // Delivery is proven by an authenticated, well-formed webhook - stamped on
    // the matched source, before the evidence gate, even when everything dedups.
    setAlertSourceReceived(sourceKind, new Date().toISOString());

    // Evidence gate, not identity gate: a runner OR a pull-integration (metrics or
    // logs) makes an investigation worth starting; misroute protection is downstream.
    if (
      getFleetView().length === 0 &&
      getPrometheusIntegration() === null &&
      getLokiIntegration() === null
    ) {
      return reply.code(503).send({
        error:
          "no evidence source available - connect a runner or the Prometheus or Loki integration to investigate alerts",
      });
    }

    let enqueued = 0;
    let skipped = 0;
    for (const alert of parsed) {
      if (routeAlert(alert) === "enqueued") enqueued++;
      else skipped++;
    }

    return reply.code(200).send({ received: parsed.length, enqueued, skipped });
  });

  // Same auth/normalizer as ingest but never routes; the fleet match is
  // advisory, telling the operator whether the agent will find an exact match.
  fastify.post<{ Body: unknown }>(
    "/alerts/validate",
    async (request, reply) => {
      const plaintext = extractToken(request.headers);
      if (!plaintext) {
        return reply.code(401).send({
          error: "X-Nightwatch-Token or Authorization: Bearer token required",
        });
      }
      if (findAlertSourceKindByToken(plaintext) === null) {
        return reply.code(401).send({ error: "unknown or revoked token" });
      }

      let parsed: ParsedAlert[];
      try {
        parsed = parseSource(request.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: msg });
      }

      if (parsed.length === 0) {
        return reply.code(400).send({
          error:
            "no alerts found in payload - expected an Alertmanager webhook or a generic { alerts: [...] } body",
        });
      }

      const fleet = getFleetView();
      const alerts = parsed.map((p) => {
        const key = serviceIdentityKey(p.targetIdentifier);
        const advertisedOn = fleet
          .filter((r) =>
            r.services.some((s) => serviceIdentityKey(s.identity) === key),
          )
          .map((r) => r.serverName ?? r.hostname);

        return {
          sourceAlertId: p.sourceAlertId,
          identity: p.targetIdentifier,
          identityKey: key,
          alertType: p.alertType,
          severity: p.severity,
          // Advisory fleet match: exact-identity owners of this alert's target.
          advertisedOn,
          exactMatch: advertisedOn.length === 1,
        };
      });

      return reply.code(200).send({ alerts });
    },
  );
}

function extractToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const token = headers["x-nightwatch-token"];
  if (typeof token === "string" && token.length > 0) return token;
  return extractBearerToken(headers["authorization"]);
}

// Source is decided by the body's structure alone - a User-Agent is client-controlled
// and spoofable, so it is not consulted.
function parseSource(body: unknown): ParsedAlert[] {
  if (isAlertmanagerShape(body)) {
    return parseAlertmanager(body);
  }
  throw new Error(
    "unrecognized payload - expected an Alertmanager webhook body ({ alerts: [...] })",
  );
}

function isAlertmanagerShape(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "alerts" in body &&
    Array.isArray((body as Record<string, unknown>)["alerts"])
  );
}
