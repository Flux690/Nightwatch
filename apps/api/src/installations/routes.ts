import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { redis } from "../redis/client.js";
import { sendCommand } from "../ws/router.js";
import { ensureAdminUser } from "../auth/admin.js";
import { logger } from "../logger.js";
import type { CapabilityManifest } from "@nightwatch/shared";

const RULES_TIMEOUT_MS = 10_000;

export async function registerInstallationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // List installations with live runner status from the heartbeat key.
  fastify.get("/installations", async () => {
    const installations = await db.installation.findMany({
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(
      installations.map(async (i) => {
        const lastSeen = await redis.get(`heartbeat:${i.token}`);
        const manifestRaw = await redis.get(`manifest:${i.token}`);
        return {
          id: i.id,
          token: i.token,
          hostname: i.hostname,
          createdAt: i.createdAt,
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

  // Generate a new installation token for a runner.
  fastify.post<{ Body: { hostname?: string } }>(
    "/installations",
    async (request, reply) => {
      const user = await ensureAdminUser();
      const installation = await db.installation.create({
        data: { userId: user.id, hostname: request.body?.hostname ?? null },
      });
      logger.info({ id: installation.id }, "installation created");
      return reply
        .code(201)
        .send({ id: installation.id, token: installation.token });
    },
  );

  // Push updated Prometheus alert rules to the runner (settings, not gated).
  fastify.patch<{ Params: { token: string }; Body: { rulesYaml?: string } }>(
    "/installations/:token/rules",
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
