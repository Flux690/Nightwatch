import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseAlertmanager } from "./parsers/alertmanager.js";
import { isDuplicate } from "./dedup.js";
import { checkRateLimit } from "./rate-limit.js";
import { batchWindow } from "./batch-window.js";
import { dispatcher } from "../dispatch/dispatcher.js";
import { findTokenByValue, touchLastUsed } from "../db/tokens.js";
import { getRunnerIdentity } from "../ws/router.js";
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
      const identity = getRunnerIdentity(tokenId);
      const runnerId = tokenRecord.runnerId ?? identity?.runnerId ?? tokenId;
      const hostname = identity?.hostname ?? undefined;

      let alerts: NormalizedAlert[];
      try {
        alerts = parseSource(
          userAgent,
          request.body,
          tokenId,
          runnerId,
          hostname,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: msg });
      }

      let enqueued = 0;
      let skipped = 0;

      for (const alert of alerts) {
        // 1. Derived dedup: same alert already active or durably suspended.
        if (isDuplicate(alert)) {
          skipped++;
          continue;
        }

        // 2. Intra-window dedup: same tokenId+sourceAlertId already queued in
        //    the batch window. True duplicate — the model would see it twice.
        if (batchWindow.has(alert.runnerId, alert.sourceAlertId)) {
          skipped++;
          continue;
        }

        // 3. Rate limit: per-server budget.
        if (!checkRateLimit(alert.runnerId, alert.severity)) {
          skipped++;
          fastify.log.warn({ alertId: alert.sourceAlertId }, "rate limited");
          continue;
        }

        // 4. Route: inject into the one active alert investigation (if any) or
        //    add to the operator-wide batch window. A suspended session is not
        //    in the active set, so it falls through to the batch window and a
        //    new session is created — suspended sessions never receive injections
        //    (CONTEXT.md alert pipeline).
        const activeSessionId = dispatcher.getActiveAlertSession();
        if (activeSessionId !== null) {
          dispatcher.injectAlert(activeSessionId, alert);
          fastify.log.info(
            { alertId: alert.sourceAlertId, sessionId: activeSessionId },
            "alert injected into active run",
          );
        } else {
          batchWindow.add(alert);
          fastify.log.info(
            { alertId: alert.sourceAlertId, type: alert.alertType },
            "alert added to batch window",
          );
        }

        enqueued++;
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
  const auth = headers["authorization"];
  if (typeof auth === "string") {
    const bearer = auth.replace(/^Bearer\s+/i, "").trim();
    if (bearer.length > 0 && bearer !== auth) return bearer;
  }
  return null;
}

function parseSource(
  userAgent: string,
  body: unknown,
  tokenId: string,
  runnerId: string,
  hostname: string | undefined,
): NormalizedAlert[] {
  if (
    userAgent.toLowerCase().includes("alertmanager") ||
    isAlertmanagerShape(body)
  ) {
    return parseAlertmanager(body, tokenId, runnerId, hostname);
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
