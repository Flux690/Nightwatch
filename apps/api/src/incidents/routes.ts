import type { FastifyInstance } from "fastify";
import {
  listPendingApprovals,
  getPendingApproval,
  resolveApproval,
} from "../investigation/approvals.js";
import { publishApprovalUpdate } from "../session/stream.js";
import { sendCommand } from "../ws/router.js";
import { requireAuth } from "../auth/gate.js";
import { logger } from "../logger.js";
import type { ApprovalResponse } from "@nightwatch/shared";

const RESOLVE_TIMEOUT_MS = 10_000;

interface ApprovalBody {
  resolvedBy?: string;
  comment?: string;
  contextMessage?: string;
}

export async function registerIncidentRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get("/incidents/pending", async () => ({
    pending: listPendingApprovals(),
  }));

  fastify.post<{ Params: { id: string }; Body: ApprovalBody }>(
    "/incidents/:id/approve",
    { preHandler: requireAuth },
    async (request, reply) => {
      const pending = getPendingApproval(request.params.id);
      if (!pending) {
        return reply.code(404).send({
          error: `No pending approval for incident ${request.params.id}`,
        });
      }

      const resolvedBy = request.body?.resolvedBy ?? "console";
      resolveApproval({
        toolUseId: pending.toolUseId,
        action: "approve",
        comment: request.body?.comment,
      });
      logger.info(
        { incidentId: pending.incidentId, tool: pending.toolName, resolvedBy },
        "approval approved via REST",
      );

      const response: ApprovalResponse = {
        incidentId: pending.incidentId,
        toolUseId: pending.toolUseId,
        status: "approved",
        resolvedBy,
        resolvedAt: new Date().toISOString(),
      };
      publishApprovalUpdate({
        incidentId: response.incidentId,
        toolUseId: response.toolUseId,
        status: "approved",
        resolvedBy: response.resolvedBy,
        resolvedAt: response.resolvedAt,
      });
      return reply.code(200).send(response);
    },
  );

  fastify.post<{ Params: { id: string }; Body: ApprovalBody }>(
    "/incidents/:id/reject",
    { preHandler: requireAuth },
    async (request, reply) => {
      const pending = getPendingApproval(request.params.id);
      if (!pending) {
        return reply.code(404).send({
          error: `No pending approval for incident ${request.params.id}`,
        });
      }

      const resolvedBy = request.body?.resolvedBy ?? "console";
      resolveApproval({
        toolUseId: pending.toolUseId,
        action: "reject",
        comment: request.body?.comment,
      });
      logger.info(
        { incidentId: pending.incidentId, tool: pending.toolName, resolvedBy },
        "approval rejected via REST",
      );

      const response: ApprovalResponse = {
        incidentId: pending.incidentId,
        toolUseId: pending.toolUseId,
        status: "rejected",
        resolvedBy,
        resolvedAt: new Date().toISOString(),
      };
      publishApprovalUpdate({
        incidentId: response.incidentId,
        toolUseId: response.toolUseId,
        status: "rejected",
        resolvedBy: response.resolvedBy,
        resolvedAt: response.resolvedAt,
      });
      return reply.code(200).send(response);
    },
  );

  // Approval state for an incident: in-memory, so present only while pending.
  fastify.get<{ Params: { id: string } }>(
    "/incidents/:id/status",
    async (request) => {
      const pending = getPendingApproval(request.params.id);
      return {
        incidentId: request.params.id,
        awaitingApproval: pending != null,
        approval: pending ?? null,
      };
    },
  );

  // Human marks an escalated incident resolved; the note is written to the
  // runner's SQLite history (the feedback loop, relayed via resolve_incident).
  fastify.post<{
    Params: { id: string };
    Body: { token?: string; note?: string };
  }>(
    "/incidents/:id/resolve",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { token, note } = request.body ?? {};
      if (!token || !note) {
        return reply.code(400).send({ error: "token and note are required" });
      }
      try {
        const result = await sendCommand(
          token,
          "resolve_incident",
          { incidentId: request.params.id, note },
          RESOLVE_TIMEOUT_MS,
        );
        logger.info({ incidentId: request.params.id }, "incident resolved");
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: msg });
      }
    },
  );
}
