import type { FastifyInstance } from "fastify";
import { listAllInterrupts } from "../db/interrupts.js";
import type { PendingInterruptWithSession } from "../db/interrupts.js";
import type { ApprovalRequest } from "@nightwatch/shared";
import { requireSession } from "../auth/session.js";

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
  fastify.get(
    "/approvals/pending",
    { preHandler: requireSession },
    async () => listAllInterrupts().map(toApprovalRequest),
  );
}
