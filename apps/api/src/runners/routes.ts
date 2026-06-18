import type { FastifyInstance } from "fastify";
import { findTokenById, listTokensMeta } from "../db/tokens.js";
import { sendCommand, listRunners } from "../ws/router.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";
import type { RunnerRecord } from "@nightwatch/shared";

const RULES_TIMEOUT_MS = 10_000;

export async function registerRunnerRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Fleet view per runner (CONTEXT.md multi-runner). Live runners come from the
  // in-memory registry (keyed by tokenId); offline tokens show as single rows so
  // their install command remains discoverable.
  fastify.get("/runners", { preHandler: requireSession }, () => {
    const live = listRunners();
    const byToken = new Map<string, typeof live>();
    for (const r of live) {
      const list = byToken.get(r.tokenId);
      if (list) list.push(r);
      else byToken.set(r.tokenId, [r]);
    }

    const records: RunnerRecord[] = [];
    for (const t of listTokensMeta()) {
      const runners = byToken.get(t.id);
      if (!runners || runners.length === 0) {
        records.push({
          id: t.runnerId ?? t.id,
          token: t.id,
          hostname: null,
          createdAt: t.createdAt,
          online: false,
          lastSeen: null,
          manifest: null,
        });
        continue;
      }
      for (const r of runners) {
        records.push({
          id: r.runnerId ?? t.runnerId ?? t.id,
          token: t.id,
          hostname: r.hostname,
          createdAt: t.createdAt,
          online: r.online,
          lastSeen: new Date(r.lastSeen).toISOString(),
          manifest: r.manifest,
        });
      }
    }
    return records;
  });

  // Push updated Prometheus alert rules to the runner (settings, not gated).
  // The URL param is the token's UUID.
  fastify.patch<{ Params: { tokenId: string }; Body: { rulesYaml?: string } }>(
    "/runners/:tokenId/rules",
    { preHandler: requireSession },
    async (request, reply) => {
      const rulesYaml = request.body?.rulesYaml;
      if (!rulesYaml) {
        return reply.code(400).send({ error: "rulesYaml is required" });
      }
      const token = findTokenById(request.params.tokenId);
      try {
        const result = await sendCommand(
          "update_alert_rules",
          { rulesYaml },
          RULES_TIMEOUT_MS,
          token?.runnerId ?? undefined,
        );
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: msg });
      }
    },
  );

  logger.info("runner routes registered");
}
