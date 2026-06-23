import { loadConfig } from "../config/store.js";
import {
  claimPendingHumanInput,
  deletePendingHumanInput,
  getPendingHumanInputWithSessionBySessionId,
} from "../db/interrupts.js";
import {
  insertExecutingRemediationAction,
  insertRejectedRemediationAction,
  settleRemediationAction,
} from "../db/remediation-actions.js";
import { dispatcher } from "../dispatcher.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { publishInterruptResolved, publishToolCallEnd } from "./stream.js";
import { buildSeed } from "./seed.js";
import { executeRunnerTool } from "../agent/executor.js";
import type { ApprovalResponse, RespondRequest } from "@nightwatch/shared";

export class HumanInputError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HumanInputActionResult extends ApprovalResponse {
  sessionId: string;
}

function requirePendingHumanInput(sessionId: string) {
  const pending = getPendingHumanInputWithSessionBySessionId(sessionId);
  if (!pending) {
    throw new HumanInputError(
      409,
      `No pending human input for session: ${sessionId}`,
    );
  }
  return pending;
}

function claimOrThrow(sessionId: string): void {
  if (!claimPendingHumanInput(sessionId)) {
    throw new HumanInputError(
      409,
      "Human input already claimed by another request",
    );
  }
}

function ensureDeleted(sessionId: string): void {
  if (!deletePendingHumanInput(sessionId)) {
    throw new HumanInputError(
      409,
      "Human input already resolved by another request",
    );
  }
}

function unpause(
  sessionId: string,
  toolUseId: string,
  status: "approved" | "rejected" | "context_added" | "answered",
  resolvedBy: string,
  completedResults: ToolResult[],
  gatedResult: ToolResult,
): HumanInputActionResult {
  ensureDeleted(sessionId);

  const resolvedAt = new Date().toISOString();

  if (status === "approved") {
    publishToolCallEnd({
      sessionId,
      toolUseId,
      result: gatedResult.content,
      isError: gatedResult.is_error,
    });
  }

  publishInterruptResolved({
    sessionId,
    toolUseId,
    status,
    resolvedBy,
    resolvedAt,
  });

  dispatcher.dispatch({
    sessionId,
    seed: buildSeed(sessionId),
    resumeToolResults: [...completedResults, gatedResult],
  });

  return { sessionId, toolUseId, status, resolvedBy, resolvedAt };
}

export async function respondToPendingHumanInput(
  sessionId: string,
  request: RespondRequest,
  resolvedBy = "console",
): Promise<HumanInputActionResult> {
  const pending = requirePendingHumanInput(sessionId);
  const { decision, text } = request;

  if (pending.kind === "clarification") {
    if (decision !== undefined) {
      throw new HumanInputError(
        400,
        "Clarification interrupts do not accept a decision; send text only",
      );
    }
    const answer = text?.trim();
    if (!answer) {
      throw new HumanInputError(400, "text is required for clarification");
    }
    claimOrThrow(sessionId);
    logger.info({ sessionId, resolvedBy }, "clarification answered");
    return unpause(
      sessionId,
      pending.toolUseId,
      "answered",
      resolvedBy,
      pending.completedResults,
      { tool_use_id: pending.toolUseId, content: answer },
    );
  }

  // kind === "approval"
  if (decision === "approve") {
    claimOrThrow(sessionId);
    const config = loadConfig();

    // Write-ahead: insert as 'executing' before dispatch. A UNIQUE conflict
    // means this tool_use_id already ran (crash-recovery path) — do not re-execute.
    const inserted = insertExecutingRemediationAction({
      toolUseId: pending.toolUseId,
      sessionId,
      toolName: pending.toolName,
      input: pending.toolInput,
    });

    let gatedResult: ToolResult;

    if (!inserted) {
      // Previously attempted — outcome unknown. Surface to the model so the
      // operator can decide whether to retry with a fresh tool call.
      logger.warn(
        { sessionId, tool: pending.toolName, toolUseId: pending.toolUseId },
        "duplicate approve: action previously attempted, skipping execution",
      );
      gatedResult = {
        tool_use_id: pending.toolUseId,
        content: `Action previously attempted (outcome unknown - may have run). Do not re-execute automatically. Inform the operator and ask whether to retry.`,
        is_error: true,
      };
    } else {
      const execResult = await executeRunnerTool(
        pending.toolName,
        pending.toolInput,
        {
          runnerId: pending.originatingAlert?.runnerId,
          toolTimeoutMs: config.toolTimeoutMs,
        },
      );
      const settled = execResult.is_error ? "failed" : "executed";
      settleRemediationAction(pending.toolUseId, settled, execResult.content);
      gatedResult = {
        tool_use_id: pending.toolUseId,
        content:
          typeof execResult.content === "string"
            ? execResult.content
            : JSON.stringify(execResult.content),
        is_error: execResult.is_error,
      };
    }

    logger.info({ sessionId, tool: pending.toolName, resolvedBy }, "approved");
    return unpause(
      sessionId,
      pending.toolUseId,
      "approved",
      resolvedBy,
      pending.completedResults,
      gatedResult,
    );
  }

  if (decision === "reject") {
    const isCritical =
      (pending.originatingAlert?.severity ?? "info") === "critical";
    const comment = text?.trim() ?? "";
    const gatedResult: ToolResult = {
      tool_use_id: pending.toolUseId,
      content: isCritical
        ? `The operator rejected this tool use as too risky. The action was NOT executed. Comment: ${comment || "no comment"}. Reassess the situation, summarize what you observed, and suggest a safer alternative.`
        : `The operator rejected this tool use. The action was NOT executed - no changes were made to the system. Comment: ${comment || "no comment"}. Stop current remediation, explain why you chose this tool, and ask for guidance.`,
      is_error: true,
    };
    claimOrThrow(sessionId);
    insertRejectedRemediationAction({
      toolUseId: pending.toolUseId,
      sessionId,
      toolName: pending.toolName,
      input: pending.toolInput,
    });
    logger.info({ sessionId, tool: pending.toolName, resolvedBy }, "rejected");
    return unpause(
      sessionId,
      pending.toolUseId,
      "rejected",
      resolvedBy,
      pending.completedResults,
      gatedResult,
    );
  }

  // No decision — treat as add-context (Other path)
  const context = text?.trim();
  if (!context) {
    throw new HumanInputError(
      400,
      "approval interrupts require decision (approve/reject) or text (add context)",
    );
  }
  claimOrThrow(sessionId);
  logger.info(
    { sessionId, tool: pending.toolName, resolvedBy },
    "context added",
  );
  return unpause(
    sessionId,
    pending.toolUseId,
    "context_added",
    resolvedBy,
    pending.completedResults,
    {
      tool_use_id: pending.toolUseId,
      content: `Human added context: ${context}`,
    },
  );
}
