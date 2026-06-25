import type { FastifyInstance } from "fastify";
import { serviceIdentityKey } from "@nightwatch/shared";
import { parseAlertmanager, type ParsedAlert } from "./parsers/alertmanager.js";
import { resolveAlerts } from "./resolve-identity.js";
import { routeAlert } from "./route-alert.js";
import { findTokenByValue, hashToken, touchLastUsed } from "../db/tokens.js";
import { getIngestTokenHash } from "../db/user.js";
import { extractBearerToken } from "../auth/bearer.js";
import { getFleetView } from "../ws/router.js";
import { logger } from "../logger.js";

export async function registerAlertRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body: unknown }>("/alerts/ingest", async (request, reply) => {
    const userAgent = request.headers["user-agent"] ?? "";
    const plaintext = extractToken(request.headers);

    if (!plaintext) {
      return reply.code(401).send({
        error: "X-Nightwatch-Token or Authorization: Bearer token required",
      });
    }

    if (!authenticate(plaintext)) {
      return reply.code(401).send({ error: "unknown or revoked token" });
    }

    let parsed: ParsedAlert[];
    try {
      parsed = parseSource(userAgent, request.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }

    // The token authenticates the request; the alert's labels - matched
    // against the fleet's advertised services - are the sole source of
    // routing (ADR-0004 resolve-or-reject, never a token-derived guess).
    const resolution = resolveAlerts(parsed, getFleetView());
    if (resolution.kind === "rejected") {
      return reply.code(resolution.status).send({ error: resolution.error });
    }
    const alerts = resolution.alerts;

    let enqueued = 0;
    let skipped = 0;

    for (const alert of alerts) {
      if (routeAlert(alert) === "enqueued") enqueued++;
      else skipped++;
    }

    return reply.code(200).send({ received: alerts.length, enqueued, skipped });
  });

  // Lets an operator test their BYO webhook config before going live: same
  // auth, same normalizer, same fleet match as /alerts/ingest, but never
  // calls routeAlert - nothing is dispatched. Each alert is resolved
  // individually (rather than via the all-or-nothing resolveAlerts(parsed,...)
  // used at real ingest) so a payload with several alerts reports which ones
  // would route and which would be rejected, instead of one failure masking
  // the rest.
  fastify.post<{ Body: unknown }>(
    "/alerts/validate",
    async (request, reply) => {
      const plaintext = extractToken(request.headers);
      if (!plaintext) {
        return reply.code(401).send({
          error: "X-Nightwatch-Token or Authorization: Bearer token required",
        });
      }
      if (!authenticate(plaintext)) {
        return reply.code(401).send({ error: "unknown or revoked token" });
      }

      let parsed: ParsedAlert[];
      try {
        parsed = parseSource(request.headers["user-agent"] ?? "", request.body);
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
      const alerts = parsed.map((alert) => {
        const result = resolveAlerts([alert], fleet);
        const resolution =
          result.kind === "resolved"
            ? {
                status: "resolved" as const,
                // resolveAlerts is called with exactly one alert above, so a
                // "resolved" result always carries exactly that one match.
                runnerId: result.alerts[0].runnerId,
                hostname: result.alerts[0].hostname,
              }
            : { status: "rejected" as const, reason: result.error };

        return {
          sourceAlertId: alert.sourceAlertId,
          identity: alert.targetIdentifier,
          identityKey: serviceIdentityKey(alert.targetIdentifier),
          alertType: alert.alertType,
          severity: alert.severity,
          resolution,
        };
      });

      return reply.code(200).send({ alerts });
    },
  );
}

// Authenticates the request only - grants no routing information. `nwi_`
// (fleet-wide) and `nwr_` (per-runner, backward compat) both just prove the
// request may submit alerts; which runner receives it is decided later, by
// matching the alert's labels against the fleet (ADR-0004).
function authenticate(plaintext: string): boolean {
  if (plaintext.startsWith("nwi_")) {
    const ingestHash = getIngestTokenHash();
    return ingestHash !== null && hashToken(plaintext) === ingestHash;
  }

  const tokenRecord = findTokenByValue(plaintext);
  if (!tokenRecord) return false;
  // Touch before any processing so lastUsedAt reflects authenticated use.
  touchLastUsed(tokenRecord.id);
  return true;
}

function extractToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const token = headers["x-nightwatch-token"];
  if (typeof token === "string" && token.length > 0) return token;
  return extractBearerToken(headers["authorization"]);
}

function parseSource(userAgent: string, body: unknown): ParsedAlert[] {
  if (
    userAgent.toLowerCase().includes("alertmanager") ||
    isAlertmanagerShape(body)
  ) {
    return parseAlertmanager(body);
  }
  logger.warn(
    { preview: JSON.stringify(body).slice(0, 200) },
    "ingest: unknown alert source, ignoring",
  );
  return [];
}

function isAlertmanagerShape(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "alerts" in body &&
    Array.isArray((body as Record<string, unknown>)["alerts"])
  );
}
