import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseAlertmanager } from "./parsers/alertmanager.js";
import { isDuplicate } from "./dedup.js";
import { checkRateLimit } from "./rate-limit.js";
import { dispatcher } from "../dispatch/dispatcher.js";
import { findTokenByValue, touchLastUsed } from "../db/tokens.js";
import { logger } from "../logger.js";
import type { NormalizedAlert } from "@nightwatch/shared";

export async function registerAlertRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body: unknown; Querystring: { token?: string } }>(
    "/alerts/ingest",
    async (request, reply) => {
      const userAgent = request.headers["user-agent"] ?? "";
      const plaintext =
        extractToken(request.headers) ??
        (typeof request.query.token === "string" ? request.query.token : null);

      if (!plaintext) {
        return reply.code(401).send({
          error: "token query param or X-Nightwatch-Token header required",
        });
      }

      const tokenRecord = findTokenByValue(plaintext);
      if (!tokenRecord) {
        return reply.code(401).send({ error: "unknown or revoked token" });
      }

      // Touch before any processing so lastUsedAt reflects authenticated use.
      touchLastUsed(tokenRecord.id);

      // Use the token's UUID as the internal identifier for all dispatch,
      // session, and incident records — the plaintext never flows downstream.
      const tokenId = tokenRecord.id;

      let alerts: NormalizedAlert[];
      try {
        alerts = parseSource(userAgent, request.body, tokenId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: msg });
      }

      let enqueued = 0;
      let skipped = 0;

      for (const alert of alerts) {
        if (isDuplicate(alert)) {
          skipped++;
          continue;
        }

        if (!checkRateLimit(alert.token, alert.severity)) {
          skipped++;
          fastify.log.warn({ alertId: alert.sourceAlertId }, "rate limited");
          continue;
        }

        const accepted = dispatcher.dispatch({
          alert,
          sessionId: randomUUID(),
          token: tokenId,
          trigger: "alert",
        });
        if (!accepted) {
          skipped++;
          fastify.log.warn(
            { alertId: alert.sourceAlertId },
            "dispatch queue full, dropped (alert will re-fire)",
          );
          continue;
        }

        enqueued++;
        fastify.log.info(
          { alertId: alert.sourceAlertId, type: alert.alertType },
          "queued",
        );
      }

      return reply
        .code(200)
        .send({ received: alerts.length, enqueued, skipped });
    },
  );
}

function extractToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const token = headers["x-nightwatch-token"];
  if (typeof token === "string" && token.length > 0) return token;
  return null;
}

function parseSource(
  userAgent: string,
  body: unknown,
  tokenId: string,
): NormalizedAlert[] {
  if (
    userAgent.toLowerCase().includes("alertmanager") ||
    isAlertmanagerShape(body)
  ) {
    return parseAlertmanager(body, tokenId);
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
