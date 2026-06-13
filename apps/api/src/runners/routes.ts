import type { FastifyInstance } from "fastify";
import { createToken, listTokens } from "../db/tokens.js";
import { redis } from "../redis/client.js";
import { sendCommand } from "../ws/router.js";
import { requireAuth } from "../auth/gate.js";
import { logger } from "../logger.js";
import type { CapabilityManifest } from "@nightwatch/shared";

const RULES_TIMEOUT_MS = 10_000;

export async function registerRunnerRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // List runners with live status from the heartbeat key.
  fastify.get("/runners", async () => {
    const tokens = listTokens();
    return Promise.all(
      tokens.map(async (t) => {
        const lastSeen = await redis.get(`heartbeat:${t.token}`);
        const manifestRaw = await redis.get(`manifest:${t.token}`);
        return {
          id: t.id,
          token: t.token,
          hostname: t.hostname,
          createdAt: t.createdAt,
          // Heartbeat carries a 120s TTL; absence means the runner is offline.
          online: lastSeen !== null,
          lastSeen,
          manifest: manifestRaw
            ? (JSON.parse(manifestRaw) as CapabilityManifest)
            : null,
        };
      }),
    );
  });

  // Generate a new token for a runner deployment.
  fastify.post<{ Body: { hostname?: string } }>(
    "/runners",
    { preHandler: requireAuth },
    async (request, reply) => {
      const tokenRecord = createToken(request.body?.hostname ?? null);
      logger.info({ id: tokenRecord.id }, "runner token created");
      return reply
        .code(201)
        .send({ id: tokenRecord.id, token: tokenRecord.token });
    },
  );

  // Push updated Prometheus alert rules to the runner (settings, not gated).
  fastify.patch<{ Params: { token: string }; Body: { rulesYaml?: string } }>(
    "/runners/:token/rules",
    { preHandler: requireAuth },
    async (request, reply) => {
      const rulesYaml = request.body?.rulesYaml;
      if (!rulesYaml) {
        return reply.code(400).send({ error: "rulesYaml is required" });
      }
      try {
        const result = await sendCommand(
          request.params.token,
          "update_alert_rules",
          { rulesYaml },
          RULES_TIMEOUT_MS,
        );
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: msg });
      }
    },
  );
}
