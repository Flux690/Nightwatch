import type { FastifyInstance } from "fastify";
import {
  parseAlertmanager,
  type ParsedWebhook,
} from "./parsers/alertmanager.js";
import { routeDelivery } from "./route-alert.js";
import {
  findAlertSourceKindByToken,
  setAlertSourceReceived,
} from "../db/alert-sources.js";
import { markAlertCleared } from "../db/sessions.js";
import { publishReportUpdated } from "../session/stream.js";
import {
  getLokiIntegration,
  getPrometheusIntegration,
} from "../db/integrations.js";
import { extractBearerToken } from "../auth/bearer.js";
import { getFleetView } from "../ws/fleet.js";
import {
  checkLLMReadiness,
  notConfiguredMessage,
} from "../config/readiness.js";

export async function registerAlertRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body: unknown }>("/alerts/ingest", async (request, reply) => {
    const plaintext = extractToken(request.headers);

    if (!plaintext) {
      return reply.code(401).send({
        error: "X-NightWarden-Token or Authorization: Bearer token required",
      });
    }

    const sourceKind = findAlertSourceKindByToken(plaintext);
    if (sourceKind === null) {
      return reply.code(401).send({ error: "unknown or revoked token" });
    }

    let parsed: ParsedWebhook;
    try {
      parsed = parseSource(request.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }

    // Delivery is proven by an authenticated, well-formed webhook - stamped on
    // the matched source, before the evidence gate, even when everything dedups.
    setAlertSourceReceived(sourceKind, new Date().toISOString());

    // Nothing to investigate with, in the other direction: evidence exists but no
    // model can reason over it. 503 rather than a drop, so Alertmanager retries
    // once the user finishes setup instead of losing the alert.
    const readiness = checkLLMReadiness();
    if (!readiness.ready) {
      return reply
        .code(503)
        .send({ error: notConfiguredMessage(readiness.missing) });
    }

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

    // A clear is recorded before anything is routed, so a batch that clears one
    // alert and fires another leaves both facts on the sessions they belong to.
    const clearedAt = new Date().toISOString();
    for (const sourceAlertId of parsed.clearedIds) {
      for (const sessionId of markAlertCleared(sourceAlertId, clearedAt)) {
        publishReportUpdated(sessionId);
      }
    }

    const { enqueued, skipped } = routeDelivery(
      parsed.groupKey,
      parsed.firing,
      parsed.truncatedAlerts,
    );

    return reply
      .code(200)
      .send({ received: parsed.firing.length, enqueued, skipped });
  });
}

function extractToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const token = headers["x-nightwarden-token"];
  if (typeof token === "string" && token.length > 0) return token;
  return extractBearerToken(headers["authorization"]);
}

// Source is decided by the body's structure alone - a User-Agent is client-controlled
// and spoofable, so it is not consulted.
function parseSource(body: unknown): ParsedWebhook {
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
