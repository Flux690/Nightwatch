import type { FastifyInstance } from "fastify";
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
