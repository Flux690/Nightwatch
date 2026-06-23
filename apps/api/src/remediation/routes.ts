import type { FastifyInstance } from "fastify";
import type { RemediationActionRecord } from "@nightwatch/shared";
import {
  listRemediationActions,
  type RemediationAction,
} from "../db/remediation-actions.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";

function toRemediationActionRecord(
  action: RemediationAction,
): RemediationActionRecord {
  return {
    toolUseId: action.toolUseId,
    serviceIdentityKey: action.serviceIdentityKey,
    toolName: action.toolName,
    status: action.status,
    resolvedBy: action.resolvedBy,
    createdAt: action.createdAt,
    resolvedAt: action.resolvedAt,
  };
}

export async function registerRemediationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/remediation-actions",
    { preHandler: requireSession },
    async () => listRemediationActions().map(toRemediationActionRecord),
  );

  logger.info("remediation routes registered");
}
