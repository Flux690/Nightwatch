import { EventEmitter } from "node:events";
import { logger } from "../logger.js";
import type { NormalizedAlert, ApprovalDecision } from "@nightwatch/shared";
import type { ToolUse } from "../llm/types.js";

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
  logger.info(
    { incidentId, tool: tool.name, toolInput: tool.input },
    "approval pending",
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
      resolve(decision);
    });
  });
}
