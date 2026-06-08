import type { FastifyInstance } from "fastify";
import {
  listPendingApprovals,
  getPendingApproval,
  resolveApproval,
} from "../investigation/approvals.js";
import { publishApprovalUpdate } from "../session/stream.js";
import { logger } from "../logger.js";
import type { ApprovalResponse } from "@nightwatch/shared";

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
}
