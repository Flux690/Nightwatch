import { loadConfig } from "../config/store.js";
import { getTranscriptRows } from "../db/sessions.js";
import { evidenceIdsByToolUseId } from "../agent/evidence-id.js";
import type { PendingHumanInput } from "../db/interrupts.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { findTool, executeTool } from "../agent/tools/toolset.js";
import { isToolFailure } from "../agent/tools/types.js";

/* One value, so the transcript cannot say "failed" where the model was told
   otherwise. Never throws: any fault becomes a failure result, so the run resumes
   instead of the card wedging. */
export async function executeApprovedTool(
  pending: PendingHumanInput,
  call: { name: string; input: Record<string, unknown> },
): Promise<ToolResult> {
  const { sessionId, toolUseId } = pending;
  const { name: toolName, input: toolInput } = call;
  try {
    // The interrupt row is the write-ahead record: it is claimed before this runs
    // and deleted only once the result is in hand, so a claim that outlives the
    // process is what says an attempt may already have happened.
    const toolEntry = findTool(toolName);
    if (!toolEntry) {
      logger.error(
        { sessionId, tool: toolName },
        "approved tool not found in registry",
      );
      return failed(
        toolUseId,
        `Tool "${toolName}" not found in registry. Platform configuration error.`,
      );
    }

    /* The call is already in the transcript, so its number is settled: the walk
       that assigns it and the walk that resolves a citation are the same one. */
    const evidenceId = evidenceIdsByToolUseId(getTranscriptRows(sessionId)).get(
      toolUseId,
    );
    const { content, toolOutcome } = await executeTool(toolEntry, toolInput, {
      toolCallCeilingMs: loadConfig().toolCallCeilingMs,
      sessionId,
      toolUseId,
      ...(evidenceId !== undefined && { evidenceId }),
    });
    return {
      tool_use_id: toolUseId,
      content,
      is_error: isToolFailure(toolOutcome),
      ...(toolOutcome !== undefined && { toolOutcome }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { sessionId, tool: toolName, err },
      "approve path failed after claim; resolving interrupt as failed",
    );
    return failed(
      toolUseId,
      `Action failed to execute: ${msg}. No confirmed change was made. Reassess and decide whether to retry or escalate to the user.`,
    );
  }
}

// The approve path's own faults: the write never reached its tool, so the class
// is the harness breaking rather than anything the user can widen or wait out.
function failed(toolUseId: string, content: string): ToolResult {
  return {
    tool_use_id: toolUseId,
    content,
    is_error: true,
    toolOutcome: "system",
  };
}
