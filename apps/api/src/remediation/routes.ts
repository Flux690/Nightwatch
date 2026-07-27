import type { FastifyInstance } from "fastify";
import {
  listRemediationActions,
  toActionRecord,
} from "../db/remediation-actions.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";

export async function registerRemediationRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/remediation-actions",
    { preHandler: requireSession },
    async () => listRemediationActions().map(toActionRecord),
  );

  logger.info("remediation routes registered");
}
