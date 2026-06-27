import type { FastifyInstance } from "fastify";
import {
  findRunnerById,
  listRunnersMeta,
  setRemediationMode,
} from "../db/runner.js";
import {
  listRunners,
  getFleetView,
  pushRemediationMode,
} from "../ws/router.js";
import { sendCommand } from "../ws/command-transport.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";
import type { FleetRunner, RunnerRecord } from "@nightwatch/shared";

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
    for (const t of listRunnersMeta()) {
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
          remediationMode: t.remediationMode,
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
          remediationMode: t.remediationMode,
        });
      }
    }
    return records;
  });

  // The fleet view (CONTEXT.md "Fleet view"): every connected runner and the
  // server-scoped service identities it advertises. Read-only, no token
  // management fields - the console fleet page's single pane of glass.
  fastify.get("/fleet", { preHandler: requireSession }, (): FleetRunner[] =>
    getFleetView(),
  );

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
      const token = findRunnerById(request.params.tokenId);
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

  // Toggle remediation mode for a runner. Persists to DB (system of record)
  // and pushes to the connected runner over WS. A missed push self-heals on
  // the next heartbeat via manifest reconciliation in ws/server.ts.
  fastify.patch<{
    Params: { tokenId: string };
    Body: { enabled?: boolean };
  }>(
    "/runners/:tokenId/remediation-mode",
    { preHandler: requireSession },
    (request, reply) => {
      const { tokenId } = request.params;
      const { enabled } = request.body ?? {};
      if (typeof enabled !== "boolean") {
        return reply.code(400).send({ error: "enabled (boolean) is required" });
      }
      const row = findRunnerById(tokenId);
      if (!row) {
        return reply.code(404).send({ error: "runner not found" });
      }
      setRemediationMode(tokenId, enabled);
      pushRemediationMode(tokenId, enabled);
      return reply.code(200).send({ tokenId, remediationMode: enabled });
    },
  );

  logger.info("runner routes registered");
}
