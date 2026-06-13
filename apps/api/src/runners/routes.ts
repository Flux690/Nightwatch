import type { FastifyInstance } from "fastify";
import { createToken, listTokens } from "../db/tokens.js";
import { sendCommand, listRunners } from "../ws/router.js";
import { requireAuth } from "../auth/gate.js";
import { logger } from "../logger.js";
import type { RunnerRecord } from "@nightwatch/shared";

const RULES_TIMEOUT_MS = 10_000;

export async function registerRunnerRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // The fleet view, per runner not per token (CONTEXT.md multi-runner): liveness
  // and manifests come from the in-memory connection registry. A token with one
  // or more live runners contributes one row each (so two runners on a shared
  // token are visible independently); a token with no live runner still shows as
  // a single offline row so its install command remains discoverable.
  fastify.get("/runners", () => {
    const live = listRunners();
    const byToken = new Map<string, typeof live>();
    for (const r of live) {
      const list = byToken.get(r.token);
      if (list) list.push(r);
      else byToken.set(r.token, [r]);
    }

    const records: RunnerRecord[] = [];
    for (const t of listTokens()) {
      const runners = byToken.get(t.token);
      if (!runners || runners.length === 0) {
        records.push({
          id: t.id,
          token: t.token,
          hostname: t.hostname,
          createdAt: t.createdAt,
          online: false,
          lastSeen: null,
          manifest: null,
        });
        continue;
      }
      for (const r of runners) {
        records.push({
          id: r.runnerId,
          token: t.token,
          hostname: r.hostname ?? t.hostname,
          createdAt: t.createdAt,
          online: r.online,
          lastSeen: new Date(r.lastSeen).toISOString(),
          manifest: r.manifest,
        });
      }
    }
    return records;
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
