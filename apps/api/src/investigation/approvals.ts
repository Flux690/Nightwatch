import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import type {
  NormalizedAlert,
  ApprovalDecision,
  ApprovalRequest,
} from "@nightwatch/shared";
import type { ToolUse } from "../llm/types.js";

const APPROVAL_TIMEOUT_MS = 4 * 60_000;

export const CLARIFICATION_TIMEOUT_MS = 90_000;

export const approvalBus = new EventEmitter();
approvalBus.setMaxListeners(100);

// The loop awaits one approval at a time per investigation, so a single pending
// request per incident is sufficient. This holds the in-flight requests so the
// REST layer (and console) can list them and map an incident back to its
// toolUseId. It is the bus's listenable companion - an EventEmitter listener
// cannot be enumerated. In-memory by design (PRD 10.4 / 13.2).
const pendingApprovals = new Map<string, ApprovalRequest>();

export function listPendingApprovals(): ApprovalRequest[] {
  return [...pendingApprovals.values()];
}

export function getPendingApproval(
  incidentId: string,
): ApprovalRequest | undefined {
  return pendingApprovals.get(incidentId);
}

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

  pendingApprovals.set(incidentId, {
    id: randomUUID(),
    incidentId,
    token: alert.token,
    toolName: tool.name,
    toolInput: tool.input,
    toolUseId: tool.id,
    status: "pending",
    createdAt: new Date().toISOString(),
  });

  try {
    return await new Promise<ApprovalDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        approvalBus.removeAllListeners(`decision:${tool.id}`);
        reject(
          new Error(
            `Approval timed out after ${APPROVAL_TIMEOUT_MS / 60_000}m`,
          ),
        );
      }, APPROVAL_TIMEOUT_MS);

      approvalBus.once(`decision:${tool.id}`, (decision: ApprovalDecision) => {
        clearTimeout(timer);
        resolve(decision);
      });
    });
  } finally {
    pendingApprovals.delete(incidentId);
  }
}
