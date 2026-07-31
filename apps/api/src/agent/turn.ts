import { executeTool } from "./tools/toolset.js";
import { isToolFailure } from "./tools/types.js";
import type { Tool, ToolDispatchContext } from "./tools/types.js";
import { recordToolOutcome } from "../db/tool-outcomes.js";
import { publishTranscriptItem } from "../session/stream.js";
import { toolCallCard } from "../session/transcript.js";
import type { logger } from "../logger.js";
import type { ToolResult, ToolUse } from "../llm/types.js";

export interface GatedTool {
  tool: ToolUse;
  entry: Tool;
}

export interface TurnOutcome {
  // One tool_result per non-gated tool_use, so every block in the assistant
  // message is answered even when a later one suspends the run.
  toolResults: ToolResult[];
  // The single gated (write/ask) tool to suspend on, or null if the turn had
  // none. At most one per turn; subsequent gated tools are rejected inline.
  gated: GatedTool | null;
}

// Two passes: run every non-gated read now, and pick the first gated (write/ask) tool for
// the loop to suspend on. Reads resolve against the effective set, so a stripped tool reports unavailable.
export async function processToolUses(params: {
  toolUses: ToolUse[];
  toolset: Tool[];
  sessionId: string;
  // toolUseId is per call, so the loop hands over a turn-scoped base context
  // and each execution below completes it with its own tool_use id.
  execCtx: Omit<ToolDispatchContext, "toolUseId">;
  log: typeof logger;
}): Promise<TurnOutcome> {
  const { toolUses, toolset, sessionId, execCtx, log } = params;

  const toolResults: ToolResult[] = [];
  let gatedTool: ToolUse | null = null;
  let gatedEntry: Tool | null = null;

  for (const tool of toolUses) {
    // Resolve against the effective set, not the full registry, so a tool stripped
    // by fleet providers or integrations never reaches the gate.
    const entry = toolset.find((t) => t.schema.name === tool.name);

    if (!entry) {
      log.warn({ tool: tool.name }, "LLM requested unavailable tool");
      toolResults.push({
        tool_use_id: tool.id,
        content: `Tool "${tool.name}" is not available in this investigation. Do not retry.`,
        is_error: true,
      });
      recordToolOutcome(sessionId, tool.id, "system");
      continue;
    }

    if (entry.access === "write" || entry.access === "ask") {
      if (gatedTool !== null) {
        // Only one gate per turn; reject subsequent gated tools so every
        // tool_use in this assistant message still gets a tool_result.
        toolResults.push({
          tool_use_id: tool.id,
          content: "Another gated action is pending. Retry after it resolves.",
          is_error: true,
        });
        recordToolOutcome(sessionId, tool.id, "system");
        continue;
      }

      gatedTool = tool;
      gatedEntry = entry;
      continue;
    }

    // access === "read": execute immediately
    publishTranscriptItem({
      sessionId,
      item: toolCallCard({
        toolUseId: tool.id,
        toolName: tool.name,
        input: tool.input,
        state: { phase: "running" },
      }),
    });
    const result = await executeTool(entry, tool.input, {
      ...execCtx,
      toolUseId: tool.id,
    });
    const content =
      typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content);
    toolResults.push({
      tool_use_id: tool.id,
      content,
      is_error: isToolFailure(result.outcome),
    });
    if (result.outcome !== undefined) {
      recordToolOutcome(sessionId, tool.id, result.outcome);
    }
    publishTranscriptItem({
      sessionId,
      item: toolCallCard({
        toolUseId: tool.id,
        toolName: tool.name,
        input: tool.input,
        // The same string the transcript fetch would show, so a reload cannot
        // render this result differently from the live card.
        state: {
          phase: "complete",
          result: content,
          ...(result.outcome !== undefined && { outcome: result.outcome }),
        },
      }),
    });
  }

  return {
    toolResults,
    gated:
      gatedTool !== null && gatedEntry !== null
        ? { tool: gatedTool, entry: gatedEntry }
        : null,
  };
}
