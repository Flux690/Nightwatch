import { loadConfig } from "../config/store.js";
import {
  insertExecutingRemediationAction,
  settleRemediationAction,
} from "../db/remediation-actions.js";
import type { PendingHumanInputWithSession } from "../db/interrupts.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { findTool, executeTool } from "../agent/tools.js";

// Executes an approved write tool and returns the result to feed back into the
// run. Deliberately never throws: once the interrupt is claimed it can never be
// re-approved, so the caller MUST be able to resolve it. Any fault - a duplicate
// attempt, a missing registry entry, a DB-layer error - becomes an is_error
// result so the run resumes with a failure instead of the approval card wedging.
export async function executeApprovedTool(
  pending: PendingHumanInputWithSession,
  resolvedBy: string,
): Promise<ToolResult> {
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
      return {
        tool_use_id: toolUseId,
        content: `Action previously attempted (outcome unknown - may have run). Do not re-execute automatically. Inform the operator and ask whether to retry.`,
        is_error: true,
      };
    }

    const toolEntry = findTool(toolName);
    if (!toolEntry) {
      logger.error(
        { sessionId, tool: toolName },
        "approved tool not found in registry",
      );
      const result: ToolResult = {
        tool_use_id: toolUseId,
        content: `Tool "${toolName}" not found in registry. Platform configuration error.`,
        is_error: true,
      };
      settleRemediationAction(sessionId, toolUseId, "failed", result.content);
      return result;
    }

    const execResult = await executeTool(toolEntry, toolInput, {
      runnerId: pending.originatingAlert?.runnerId,
      toolTimeoutMs: loadConfig().toolTimeoutMs,
    });
    settleRemediationAction(
      sessionId,
      toolUseId,
      execResult.is_error ? "failed" : "executed",
      execResult.content,
    );
    return {
      tool_use_id: toolUseId,
      content:
        typeof execResult.content === "string"
          ? execResult.content
          : JSON.stringify(execResult.content),
      is_error: execResult.is_error,
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
    return {
      tool_use_id: toolUseId,
      content: `Action failed to execute: ${msg}. No confirmed change was made. Reassess and decide whether to retry or escalate to the operator.`,
      is_error: true,
    };
  }
}
