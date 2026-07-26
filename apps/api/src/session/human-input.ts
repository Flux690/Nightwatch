import {
  claimPendingHumanInput,
  deletePendingHumanInput,
  getPendingHumanInputWithSessionBySessionId,
} from "../db/interrupts.js";
import { insertRejectedRemediationAction } from "../db/remediation-actions.js";
import { dispatcher } from "../dispatcher.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { publishInterruptResolved, publishTranscriptItem } from "./stream.js";
import { toolCallCard, stripEvidenceTag } from "./transcript.js";
import { buildSeed } from "./seed.js";
import { executeApprovedTool } from "./approval-executor.js";
import type { ApprovalResponse, RespondRequest } from "@nightwarden/shared";

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
  card: { toolName: string; input: Record<string, unknown> },
): HumanInputActionResult {
  ensureDeleted(sessionId);

  const resolvedAt = new Date().toISOString();

  publishTranscriptItem({
    sessionId,
    item: toolCallCard({
      toolUseId,
      toolName: card.toolName,
      input: card.input,
      state: {
        phase: "resolved",
        decision: status,
        by: resolvedBy,
        ...(status === "approved" && {
          result: stripEvidenceTag(gatedResult.content),
        }),
      },
    }),
  });

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

  if (pending.kind === "continue") {
    // No async work between resolve and dispatch, so ensureDeleted alone is the
    // concurrency gate; claimOrThrow is skipped since nothing here executes async.
    ensureDeleted(sessionId);
    const resolvedAt = new Date().toISOString();
    if (decision === "reject") {
      publishInterruptResolved({
        sessionId,
        toolUseId: pending.toolUseId,
        status: "rejected",
        resolvedBy,
        resolvedAt,
      });
      logger.info(
        { sessionId, resolvedBy },
        "continue request ended by operator",
      );
      dispatcher.dispatch({
        sessionId,
        seed: buildSeed(sessionId),
        wrapUp: true,
      });
      return {
        sessionId,
        toolUseId: pending.toolUseId,
        status: "rejected",
        resolvedBy,
        resolvedAt,
      };
    }
    publishInterruptResolved({
      sessionId,
      toolUseId: pending.toolUseId,
      status: "continued",
      resolvedBy,
      resolvedAt,
    });
    logger.info(
      { sessionId, resolvedBy },
      "continue request resumed by operator",
    );
    dispatcher.dispatch({ sessionId, seed: buildSeed(sessionId) });
    return {
      sessionId,
      toolUseId: pending.toolUseId,
      status: "continued",
      resolvedBy,
      resolvedAt,
    };
  }

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
      { toolName: pending.toolName, input: pending.toolInput },
    );
  }

  // kind === "approval"
  if (decision === "approve") {
    // executeApprovedTool never throws - every fault becomes an is_error result -
    // so the approve path always reaches unpause() and the run always resumes.
    claimOrThrow(sessionId);
    const gatedResult = await executeApprovedTool(pending, resolvedBy);
    logger.info({ sessionId, tool: pending.toolName, resolvedBy }, "approved");
    return unpause(
      sessionId,
      pending.toolUseId,
      "approved",
      resolvedBy,
      pending.completedResults,
      gatedResult,
      { toolName: pending.toolName, input: pending.toolInput },
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
    const wrote = insertRejectedRemediationAction({
      toolUseId: pending.toolUseId,
      sessionId,
      toolName: pending.toolName,
      input: pending.toolInput,
      resolvedBy,
    });
    if (!wrote) {
      logger.warn(
        { sessionId, tool: pending.toolName, toolUseId: pending.toolUseId },
        "reject record skipped: existing row holds the slot — action may have run before crash",
      );
    }
    logger.info({ sessionId, tool: pending.toolName, resolvedBy }, "rejected");
    return unpause(
      sessionId,
      pending.toolUseId,
      "rejected",
      resolvedBy,
      pending.completedResults,
      gatedResult,
      { toolName: pending.toolName, input: pending.toolInput },
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
    { toolName: pending.toolName, input: pending.toolInput },
  );
}
