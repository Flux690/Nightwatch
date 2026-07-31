import { loadConfig } from "../config/store.js";
import {
  insertExecutingRemediationAction,
  settleRemediationAction,
} from "../db/remediation-actions.js";
import type { PendingHumanInput } from "../db/interrupts.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { findTool, executeTool } from "../agent/tools/toolset.js";
import { isToolFailure } from "../agent/tools/types.js";
import { recordToolOutcome } from "../db/tool-outcomes.js";
import type { ToolOutcome } from "@nightwarden/shared";

// What the model is sent back, and how the console draws the settled card. The
// two travel together so the transcript cannot say "failed" where the model was
// told otherwise.
export interface ApprovedToolResult {
  result: ToolResult;
  outcome?: ToolOutcome;
}

// Never throws: any fault becomes a failure result so the run resumes instead
// of the card wedging.
export async function executeApprovedTool(
  pending: PendingHumanInput,
  resolvedBy: string,
): Promise<ApprovedToolResult> {
  const { sessionId, toolUseId, toolName, toolInput } = pending;
  try {
    // Write-ahead: insert as 'executing' before dispatch. A UNIQUE conflict means
    // this tool_use_id already ran (crash-recovery path) - do not re-execute.
    const inserted = insertExecutingRemediationAction({
      toolUseId,
      sessionId,
      toolName,
      input: toolInput,
      resolvedBy,
    });
    if (!inserted) {
      // Previously attempted - outcome unknown. Surface to the model so the
      // operator can decide whether to retry with a fresh tool call.
      logger.warn(
        { sessionId, tool: toolName, toolUseId },
        "duplicate approve: action previously attempted, skipping execution",
      );
      return failed(
        sessionId,
        toolUseId,
        `Action previously attempted (outcome unknown - may have run). Do not re-execute automatically. Inform the operator and ask whether to retry.`,
      );
    }

    const toolEntry = findTool(toolName);
    if (!toolEntry) {
      logger.error(
        { sessionId, tool: toolName },
        "approved tool not found in registry",
      );
      const detail = `Tool "${toolName}" not found in registry. Platform configuration error.`;
      settleRemediationAction(sessionId, toolUseId, "failed", detail);
      return failed(sessionId, toolUseId, detail);
    }

    const execResult = await executeTool(toolEntry, toolInput, {
      toolCallCeilingMs: loadConfig().toolCallCeilingMs,
      sessionId,
      toolUseId,
    });
    const isFailure = isToolFailure(execResult.outcome);
    settleRemediationAction(
      sessionId,
      toolUseId,
      isFailure ? "failed" : "executed",
      execResult.content,
    );
    if (execResult.outcome !== undefined) {
      recordToolOutcome(sessionId, toolUseId, execResult.outcome);
    }
    return {
      result: {
        tool_use_id: toolUseId,
        content:
          typeof execResult.content === "string"
            ? execResult.content
            : JSON.stringify(execResult.content),
        is_error: isFailure,
      },
      ...(execResult.outcome !== undefined && { outcome: execResult.outcome }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { sessionId, tool: toolName, err },
      "approve path failed after claim; resolving interrupt as failed",
    );
    try {
      settleRemediationAction(sessionId, toolUseId, "failed", msg);
    } catch {
      // The write-ahead row may not exist (the insert itself failed). Nothing
      // to settle; the run still resumes with the failure result below.
    }
    return failed(
      sessionId,
      toolUseId,
      `Action failed to execute: ${msg}. No confirmed change was made. Reassess and decide whether to retry or escalate to the operator.`,
    );
  }
}

// The approve path's own faults: the write never reached its tool, so the class
// is the harness breaking rather than anything the operator can widen or wait out.
function failed(
  sessionId: string,
  toolUseId: string,
  content: string,
): ApprovedToolResult {
  try {
    recordToolOutcome(sessionId, toolUseId, "system");
  } catch (err) {
    // This path is already handling a fault, and a wedged card is worse than a
    // reloaded row that renders unclassified. The live card still shows it.
    logger.warn({ err, sessionId, toolUseId }, "tool outcome not recorded");
  }
  return {
    result: { tool_use_id: toolUseId, content, is_error: true },
    outcome: "system",
  };
}
