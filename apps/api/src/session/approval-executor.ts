import { loadConfig } from "../config/store.js";
import { getTranscriptRows } from "./transcript-store.js";
import { evidenceIdsIn } from "../agent/evidence-id.js";
import type { PendingHumanInput } from "./gate-store.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { findTool, executeTool } from "../agent/tools/toolset.js";

/* One value, so the transcript cannot say "failed" where the model was told
   otherwise. Never throws: a fault becomes a result, so the card never wedges. */
export async function executeApprovedTool(
  pending: PendingHumanInput,
  call: { name: string; input: Record<string, unknown> },
): Promise<ToolResult> {
  const { sessionId, toolCallId } = pending;
  const { name: toolName, input: toolInput } = call;
  try {
    // The interrupt row is the write-ahead record, so a claim outliving the
    // process is what says an attempt may already have happened.
    const toolEntry = findTool(toolName);
    if (!toolEntry) {
      logger.error(
        { sessionId, tool: toolName },
        "approved tool not found in registry",
      );
      return failed(
        toolCallId,
        `Tool "${toolName}" not found in registry. Platform configuration error.`,
      );
    }

    /* The call is already in the transcript, so its number is settled: the walk
       that assigns it and the walk that resolves a citation are the same one. */
    const evidenceId = evidenceIdsIn(await getTranscriptRows(sessionId)).get(
      toolCallId,
    );
    const { content, isError } = await executeTool(toolEntry, toolInput, {
      toolCallCeilingMs: (await loadConfig()).toolCallCeilingMs,
      sessionId,
      toolCallId,
      ...(evidenceId !== undefined && { evidenceId }),
    });
    return {
      toolCallId,
      content,
      ...(isError === true && { isError: true }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { sessionId, tool: toolName, err },
      "approve path failed after claim; resolving interrupt as failed",
    );
    return failed(
      toolCallId,
      `Action failed to execute: ${msg}. No confirmed change was made. Reassess and decide whether to retry or escalate to the user.`,
    );
  }
}

// The approve path's own faults: the write never reached its tool.
function failed(toolCallId: string, content: string): ToolResult {
  return { toolCallId, content, isError: true };
}
