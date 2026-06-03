import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { db } from "../db/client.js";
import type { NormalizedAlert, ApprovalDecision } from "@nightwatch/shared";
import type { ToolUse } from "../llm/provider.js";

// Must be less than the investigation hard timeout so approvals can expire before the loop does.
const APPROVAL_TIMEOUT_MS = 4 * 60_000;

export const CLARIFICATION_TIMEOUT_MS = 90_000;

export const approvalBus = new EventEmitter();
approvalBus.setMaxListeners(100);

export function resolveApproval(decision: ApprovalDecision): void {
  approvalBus.emit(`decision:${decision.toolUseId}`, decision);
}

export async function requestApproval(
  alert: NormalizedAlert,
  incidentId: string,
  tool: ToolUse,
): Promise<ApprovalDecision> {
  const approvalId = randomUUID();

  await db.approvalRequest.create({
    data: {
      id: approvalId,
      incidentId,
      installationId: alert.installationId,
      toolName: tool.name,
      toolInput: tool.input,
      toolUseId: tool.id,
      status: "pending",
    },
  });

  /* Phase 5: post approval card to Slack here */
  console.log(
    `[approval] PENDING incidentId=${incidentId} tool=${tool.name} id=${tool.id}`,
    JSON.stringify(tool.input, null, 2),
  );

  return new Promise<ApprovalDecision>((resolve, reject) => {
    const timer = setTimeout(() => {
      approvalBus.removeAllListeners(`decision:${tool.id}`);
      reject(
        new Error(`Approval timed out after ${APPROVAL_TIMEOUT_MS / 60_000}m`),
      );
    }, APPROVAL_TIMEOUT_MS);

    approvalBus.once(`decision:${tool.id}`, (decision: ApprovalDecision) => {
      clearTimeout(timer);
      void db.approvalRequest.update({
        where: { id: approvalId },
        data: {
          status:
            decision.action === "approve"
              ? "approved"
              : decision.action === "reject"
                ? "rejected"
                : "context_added",
          comment: decision.comment,
          resolvedAt: new Date(),
        },
      });
      resolve(decision);
    });
  });
}
