import type { FastifyInstance } from "fastify";
import type {
  RemediationActionRecord,
  UnresolvedAlertRecord,
} from "@nightwatch/shared";
import {
  listRemediationActions,
  type RemediationAction,
} from "../db/remediation-actions.js";
import {
  listUnresolvedAlerts,
  type UnresolvedAlert,
} from "../db/unresolved-alerts.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";

function toRemediationActionRecord(
  action: RemediationAction,
): RemediationActionRecord {
  return {
    sessionId: action.sessionId,
    toolUseId: action.toolUseId,
    serviceIdentityKey: action.serviceIdentityKey,
    toolName: action.toolName,
    status: action.status,
    resolvedBy: action.resolvedBy,
    createdAt: action.createdAt,
    resolvedAt: action.resolvedAt,
  };
}

function toUnresolvedAlertRecord(
  alert: UnresolvedAlert,
): UnresolvedAlertRecord {
  return {
    sourceAlertId: alert.sourceAlertId,
    identityKey: alert.identityKey,
    alertType: alert.alertType,
    severity: alert.severity,
    rejectionReason: alert.rejectionReason,
    createdAt: alert.createdAt,
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

  fastify.get("/unresolved-alerts", { preHandler: requireSession }, async () =>
    listUnresolvedAlerts().map(toUnresolvedAlertRecord),
  );

  logger.info("remediation routes registered");
}
