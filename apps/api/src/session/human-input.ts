import {
  claimPendingHumanInput,
  deletePendingHumanInput,
  getPendingHumanInputBySessionId,
} from "../db/interrupts.js";
import { insertRejectedRemediationAction } from "../db/remediation-actions.js";
import { dispatcher } from "../dispatcher.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { publishInterruptResolved, publishTranscriptItem } from "./stream.js";
import { toolCallCard } from "./transcript.js";
import { buildSeed } from "./seed.js";
import { executeApprovedTool } from "./approval-executor.js";
import type {
  ApprovalResponse,
  RespondRequest,
  ToolOutcome,
} from "@nightwarden/shared";

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
  const pending = getPendingHumanInputBySessionId(sessionId);
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
  status: "approved" | "rejected" | "answered",
  resolvedBy: string,
  completedResults: ToolResult[],
  gatedResult: ToolResult,
  card: { toolName: string; input: Record<string, unknown> },
  outcome?: ToolOutcome,
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
        ...(status === "approved" && { result: gatedResult.content }),
        ...(outcome !== undefined && { outcome }),
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
    const { result, outcome } = await executeApprovedTool(pending, resolvedBy);
    logger.info({ sessionId, tool: pending.toolName, resolvedBy }, "approved");
    return unpause(
      sessionId,
      pending.toolUseId,
      "approved",
      resolvedBy,
      pending.completedResults,
      result,
      { toolName: pending.toolName, input: pending.toolInput },
      outcome,
    );
  }

  if (decision === "reject") {
    // Only what is true: the operator said no. Why is in their comment or it is
    // unknown, and inferring a motive from the alert's severity hands the agent
    // one nobody gave. A rejection redirects the work, so this asks what next.
    const comment = text?.trim() ?? "";
    const gatedResult: ToolResult = {
      tool_use_id: pending.toolUseId,
      content: `The operator rejected this call, so it did not run and nothing on the system changed. ${
        comment
          ? `They said: "${comment}". Take that into account`
          : "They gave no reason. Take the rejection itself as the signal"
      }, then continue the investigation with a different approach. Do not call this tool again with the same arguments.`,
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

  throw new HumanInputError(
    400,
    "an approval requires a decision of approve or reject",
  );
}
