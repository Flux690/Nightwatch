import type { FastifyInstance } from "fastify";
import { parseAlertmanager } from "./parsers/alertmanager.js";
import { isDuplicate } from "./dedup.js";
import { checkRateLimit, tryDebounce, enqueueInvestigation } from "./queue.js";
import { db } from "../db/client.js";
import { logger } from "../logger.js";
import type { NormalizedAlert } from "@nightwatch/shared";

export async function registerAlertRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body: unknown; Querystring: { token?: string } }>(
    "/alerts/ingest",
    async (request, reply) => {
      const userAgent = request.headers["user-agent"] ?? "";
      const token =
        extractToken(request.headers) ??
        (typeof request.query.token === "string" ? request.query.token : null);

      if (!token) {
        return reply.code(401).send({
          error: "token query param or X-Nightwatch-Token header required",
        });
      }

      const tokenRecord = await db.token.findUnique({ where: { token } });
      if (!tokenRecord) {
        return reply.code(401).send({ error: "unknown or revoked token" });
      }

      let alerts: NormalizedAlert[];
      try {
        alerts = parseSource(userAgent, request.body, token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: msg });
      }

      let enqueued = 0;
      let skipped = 0;

      for (const alert of alerts) {
        if (await isDuplicate(alert)) {
          skipped++;
          continue;
        }

        const allowed = await checkRateLimit(alert.token, alert.severity);
        if (!allowed) {
          skipped++;
          fastify.log.warn({ alertId: alert.sourceAlertId }, "rate limited");
          continue;
        }

        const debounced = await tryDebounce(alert.token);
        if (!debounced) {
          skipped++;
          fastify.log.info({ alertId: alert.sourceAlertId }, "debounced");
          continue;
        }

        await enqueueInvestigation(alert);
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
  token: string,
): NormalizedAlert[] {
  if (
    userAgent.toLowerCase().includes("alertmanager") ||
    isAlertmanagerShape(body)
  ) {
    return parseAlertmanager(body, token);
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
