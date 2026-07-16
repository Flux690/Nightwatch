import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { serviceIdentityKey } from "@nightwatch/shared";
import { parseAlertmanager, type ParsedAlert } from "./parsers/alertmanager.js";
import { routeAlert } from "./route-alert.js";
import { findRunnerByToken, hashToken } from "../db/runner.js";
import { getPrometheusIntegration } from "../db/prometheus-integration.js";
import { getIngestTokenHash, setLastAlertReceived } from "../db/user.js";
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

    if (!authenticate(plaintext)) {
      return reply.code(401).send({ error: "unknown or revoked token" });
    }

    let parsed: ParsedAlert[];
    try {
      parsed = parseSource(request.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }

    // Delivery is proven by an authenticated, well-formed webhook - stamped
    // before the evidence gate below, and even when every alert dedups away.
    setLastAlertReceived(new Date().toISOString());

    // Evidence gate, not identity gate: a runner OR the Prometheus integration
    // makes an investigation worth starting; misroute protection is downstream.
    if (getFleetView().length === 0 && getPrometheusIntegration() === null) {
      return reply.code(503).send({
        error:
          "no evidence source available - connect a runner or the Prometheus integration to investigate alerts",
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
      if (!authenticate(plaintext)) {
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

// Authenticates only - grants no routing. `nwi_` (fleet) and `nwr_` (per-runner) both just
// prove the request may submit; the agent decides what the alert is about.
function authenticate(plaintext: string): boolean {
  if (plaintext.startsWith("nwi_")) {
    const ingestHash = getIngestTokenHash();
    return (
      ingestHash !== null &&
      timingSafeHexEqual(hashToken(plaintext), ingestHash)
    );
  }

  const tokenRecord = findRunnerByToken(plaintext);
  if (!tokenRecord) return false;
  return true;
}

// Constant-time compare of two hex digests so token validation leaks no timing
// information, consistent with the rest of the token-handling posture.
function timingSafeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
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
