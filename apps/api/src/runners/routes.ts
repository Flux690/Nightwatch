import type { FastifyInstance } from "fastify";
import {
  findRunnerById,
  listRunnersMeta,
  setRemediationMode,
} from "../db/runner.js";
import { listRunners, getFleetView, pushRemediationMode } from "../ws/fleet.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";
import type { FleetRunner, RunnerRecord } from "@nightwatch/shared";

export async function registerRunnerRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Live runners come from the in-memory registry; offline tokens show as
  // single rows so their install command remains discoverable.
  fastify.get("/runners", { preHandler: requireSession }, () => {
    const live = listRunners();
    const byRunner = new Map<string, typeof live>();
    for (const r of live) {
      const list = byRunner.get(r.runnerId);
      if (list) list.push(r);
      else byRunner.set(r.runnerId, [r]);
    }

    const records: RunnerRecord[] = [];
    for (const t of listRunnersMeta()) {
      const runners = byRunner.get(t.id);
      if (!runners || runners.length === 0) {
        records.push({
          id: t.id,
          token: t.id,
          serverName: t.serverName,
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
          id: t.id,
          token: t.id,
          serverName: t.serverName,
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

  // Read-only, no token management fields - the console fleet page's single
  // pane of glass.
  fastify.get("/fleet", { preHandler: requireSession }, (): FleetRunner[] =>
    getFleetView(),
  );

  // Persists to DB and pushes over WS; a missed push self-heals on the next
  // heartbeat via manifest reconciliation in ws/server.ts.
  fastify.patch<{
    Params: { id: string };
    Body: { enabled?: boolean };
  }>(
    "/runners/:id/remediation-mode",
    { preHandler: requireSession },
    (request, reply) => {
      const { id: runnerId } = request.params;
      const { enabled } = request.body ?? {};
      if (typeof enabled !== "boolean") {
        return reply.code(400).send({ error: "enabled (boolean) is required" });
      }
      const row = findRunnerById(runnerId);
      if (!row) {
        return reply.code(404).send({ error: "runner not found" });
      }
      setRemediationMode(runnerId, enabled);
      pushRemediationMode(runnerId, enabled);
      return reply.code(200).send({ runnerId, remediationMode: enabled });
    },
  );

  logger.info("runner routes registered");
}
