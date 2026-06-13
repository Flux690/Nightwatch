import type { FastifyInstance } from "fastify";
import { listInterruptsByToken } from "../db/interrupts.js";
import type { PendingInterruptWithSession } from "../db/interrupts.js";
import type { ApprovalRequest } from "@nightwatch/shared";

function toApprovalRequest(i: PendingInterruptWithSession): ApprovalRequest {
  return {
    id: i.id,
    incidentId: i.id,
    token: i.token,
    toolName: i.toolName,
    toolInput: i.toolInput,
    toolUseId: i.toolUseId,
    status: "pending",
    createdAt: i.createdAt,
  };
}

export async function registerApprovalRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get<{ Querystring: { token?: string } }>(
    "/approvals/pending",
    async (request, reply) => {
      const { token } = request.query;
      if (!token) {
        return reply.code(400).send({ error: "token is required" });
      }
      return listInterruptsByToken(token).map(toApprovalRequest);
    },
  );
}
