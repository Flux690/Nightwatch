import { loadConfig } from "../config/store.js";
import {
  claimPendingHumanInput,
  deletePendingHumanInput,
  getPendingHumanInputWithSessionBySessionId,
} from "../db/interrupts.js";
import { getSessionMessages } from "../db/sessions.js";
import { dispatcher } from "../dispatch/dispatcher.js";
import { escalate } from "../investigation/result.js";
import type { ProviderMessage, ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import {
  publishInterruptResolved,
  publishToolCallEnd,
} from "../session/stream.js";
import { sendCommand } from "../ws/router.js";
import type { ApprovalResponse } from "@nightwatch/shared";

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

function buildSeed(sessionId: string): ProviderMessage[] {
  return getSessionMessages(sessionId).map((message) => ({
    role: message.role,
    content: message.content,
    providerContent: message.providerContent,
  }));
}

function requirePendingHumanInput(sessionId: string) {
  const pendingHumanInput = getPendingHumanInputWithSessionBySessionId(sessionId);
  if (!pendingHumanInput) {
    throw new HumanInputError(
      409,
      `No pending human input for session: ${sessionId}`,
    );
  }
  return pendingHumanInput;
}

function ensureDeleted(sessionId: string): void {
  if (!deletePendingHumanInput(sessionId)) {
    throw new HumanInputError(
      409,
      "Human input already resolved by another request",
    );
  }
}

function resolvedAt(): string {
  return new Date().toISOString();
}

function buildResponse(
  sessionId: string,
  toolUseId: string,
  status: HumanInputActionResult["status"],
  resolvedBy: string,
  at: string,
): HumanInputActionResult {
  return {
    sessionId,
    toolUseId,
    status,
    resolvedBy,
    resolvedAt: at,
  };
}

export async function approvePendingHumanInput(
  sessionId: string,
  resolvedBy = "console",
): Promise<HumanInputActionResult> {
  const pendingHumanInput = requirePendingHumanInput(sessionId);
  if (!claimPendingHumanInput(sessionId)) {
    throw new HumanInputError(
      409,
      "Human input already claimed by another request",
    );
  }
  const config = loadConfig();

  let gatedResult: ToolResult;
  try {
    const result = await sendCommand(
      pendingHumanInput.toolName,
      pendingHumanInput.toolInput,
      config.toolTimeoutMs,
      pendingHumanInput.originatingAlert?.runnerId,
    );
    gatedResult = {
      tool_use_id: pendingHumanInput.toolUseId,
      content: JSON.stringify(result),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    gatedResult = {
      tool_use_id: pendingHumanInput.toolUseId,
      content: `Error executing ${pendingHumanInput.toolName}: ${message}`,
      is_error: true,
    };
  }

  ensureDeleted(sessionId);

  const at = resolvedAt();
  publishToolCallEnd({
    sessionId,
    toolUseId: pendingHumanInput.toolUseId,
    result: gatedResult.content,
    isError: gatedResult.is_error,
  });
  publishInterruptResolved({
    sessionId,
    toolUseId: pendingHumanInput.toolUseId,
    status: "approved",
    resolvedBy,
    resolvedAt: at,
  });

  logger.info(
    { sessionId, tool: pendingHumanInput.toolName, resolvedBy },
    "approved",
  );

  dispatcher.dispatch({
    sessionId,
    seed: buildSeed(sessionId),
    resumeToolResults: [...pendingHumanInput.completedResults, gatedResult],
  });

  return buildResponse(
    sessionId,
    pendingHumanInput.toolUseId,
    "approved",
    resolvedBy,
    at,
  );
}

export function rejectPendingHumanInput(
  sessionId: string,
  comment?: string,
  resolvedBy = "console",
): HumanInputActionResult {
  const pendingHumanInput = requirePendingHumanInput(sessionId);
  const gatedResult: ToolResult = {
    tool_use_id: pendingHumanInput.toolUseId,
    content:
      (pendingHumanInput.originatingAlert?.severity ?? "info") === "critical"
        ? `The operator rejected this tool use as too risky. The action was NOT executed. Comment: ${comment ?? "no comment"}. This incident has been escalated. Summarize what you observed for the on-call engineer.`
        : `The operator rejected this tool use. The action was NOT executed - no changes were made to the system. Comment: ${comment ?? "no comment"}. Stop current remediation, explain why you chose this tool, and ask for guidance.`,
  };

  ensureDeleted(sessionId);

  const at = resolvedAt();
  publishInterruptResolved({
    sessionId,
    toolUseId: pendingHumanInput.toolUseId,
    status: "rejected",
    resolvedBy,
    resolvedAt: at,
  });

  logger.info(
    { sessionId, tool: pendingHumanInput.toolName, resolvedBy },
    "rejected",
  );

  if ((pendingHumanInput.originatingAlert?.severity ?? "info") === "critical") {
    escalate(
      {
        containerName:
          pendingHumanInput.originatingAlert?.targetIdentifier ?? "unknown",
        alertType: pendingHumanInput.originatingAlert?.alertType ?? "unknown",
        firedAt:
          pendingHumanInput.originatingAlert?.firedAt ?? new Date().toISOString(),
      },
      sessionId,
      `Write action rejected: ${pendingHumanInput.toolName}`,
    );
  }

  dispatcher.dispatch({
    sessionId,
    seed: buildSeed(sessionId),
    resumeToolResults: [...pendingHumanInput.completedResults, gatedResult],
  });

  return buildResponse(
    sessionId,
    pendingHumanInput.toolUseId,
    "rejected",
    resolvedBy,
    at,
  );
}

export function addPendingHumanInputContext(
  sessionId: string,
  contextMessage?: string,
  comment?: string,
  resolvedBy = "console",
): HumanInputActionResult {
  const pendingHumanInput = requirePendingHumanInput(sessionId);
  if (pendingHumanInput.kind === "clarification") {
    throw new HumanInputError(
      400,
      "Use POST /sessions/:id/answer for clarifications",
    );
  }

  const resolvedContext = contextMessage?.trim() ?? comment?.trim();
  if (!resolvedContext) {
    throw new HumanInputError(400, "contextMessage is required");
  }

  const gatedResult: ToolResult = {
    tool_use_id: pendingHumanInput.toolUseId,
    content: `Human added context: ${resolvedContext}`,
  };

  ensureDeleted(sessionId);

  const at = resolvedAt();
  publishInterruptResolved({
    sessionId,
    toolUseId: pendingHumanInput.toolUseId,
    status: "context_added",
    resolvedBy,
    resolvedAt: at,
  });

  logger.info(
    { sessionId, tool: pendingHumanInput.toolName, resolvedBy },
    "context added",
  );

  dispatcher.dispatch({
    sessionId,
    seed: buildSeed(sessionId),
    resumeToolResults: [...pendingHumanInput.completedResults, gatedResult],
  });

  return buildResponse(
    sessionId,
    pendingHumanInput.toolUseId,
    "context_added",
    resolvedBy,
    at,
  );
}

export function answerPendingHumanInput(
  sessionId: string,
  answer: string | string[] | undefined,
  resolvedBy = "console",
): HumanInputActionResult {
  const pendingHumanInput = requirePendingHumanInput(sessionId);
  if (pendingHumanInput.kind !== "clarification") {
    throw new HumanInputError(
      400,
      "This session is not waiting for clarification",
    );
  }

  if (!answer || (typeof answer === "string" && !answer.trim())) {
    throw new HumanInputError(400, "answer is required");
  }

  const gatedResult: ToolResult = {
    tool_use_id: pendingHumanInput.toolUseId,
    content: Array.isArray(answer) ? answer.join(", ") : answer,
  };

  ensureDeleted(sessionId);

  const at = resolvedAt();
  publishInterruptResolved({
    sessionId,
    toolUseId: pendingHumanInput.toolUseId,
    status: "answered",
    resolvedBy,
    resolvedAt: at,
  });

  logger.info(
    { sessionId, tool: pendingHumanInput.toolName, resolvedBy },
    "clarification answered",
  );

  dispatcher.dispatch({
    sessionId,
    seed: buildSeed(sessionId),
    resumeToolResults: [...pendingHumanInput.completedResults, gatedResult],
  });

  return buildResponse(
    sessionId,
    pendingHumanInput.toolUseId,
    "answered",
    resolvedBy,
    at,
  );
}