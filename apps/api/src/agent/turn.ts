import { executeTool } from "./tools/toolset.js";
import type { Tool, ToolExecuteContext } from "./tools/types.js";
import { targetRemediationDisabled } from "./policy.js";
import { circuitBreakerRejection } from "./breaker.js";
import { REPORT_TOOL_SCHEMA } from "./prompts/report.js";
import { evidenceOrdinals, stampEvidence } from "./report.js";
import { publishTranscriptItem } from "../session/stream.js";
import { toolCallCard, stripEvidenceTag } from "../session/transcript.js";
import type { logger } from "../logger.js";
import type { AgentConfig } from "@nightwarden/shared";
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
  execCtx: Omit<ToolExecuteContext, "toolUseId">;
  config: AgentConfig;
  log: typeof logger;
}): Promise<TurnOutcome> {
  const { toolUses, toolset, sessionId, execCtx, config, log } = params;

  const toolResults: ToolResult[] = [];
  // Positional evidence tags for citation: derived from the persisted transcript
  // (the assistant turn is already persisted), so ordinals survive a resume.
  const ordinals = evidenceOrdinals(sessionId);
  let gatedTool: ToolUse | null = null;
  let gatedEntry: Tool | null = null;

  for (const tool of toolUses) {
    // Resolve against the effective set, not the full registry, so a tool stripped by remediation
    // mode or fleet providers never reaches the gate - this makes the master write switch unbypassable.
    const entry = toolset.find((t) => t.schema.name === tool.name);

    if (!entry) {
      log.warn({ tool: tool.name }, "LLM requested unavailable tool");
      toolResults.push({
        tool_use_id: tool.id,
        content: `Tool "${tool.name}" is not available in this investigation. Do not retry.`,
        is_error: true,
      });
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
        continue;
      }

      if (entry.access === "write") {
        // Per-target gate: a write against a machine whose remediation is off is rejected
        // before waking a human - the switch belongs to the target, not the session.
        const disabledOn = targetRemediationDisabled(tool.input);
        if (disabledOn !== null) {
          log.warn(
            { tool: tool.name, server: disabledOn },
            "write refused: remediation disabled on target server",
          );
          toolResults.push({
            tool_use_id: tool.id,
            content: `Remediation is disabled on '${disabledOn}'. The action was NOT proposed or executed. Recommend the fix in plain text instead; the operator can enable remediation for that server from the console.`,
            is_error: true,
          });
          continue;
        }

        const breakerRejection = circuitBreakerRejection(tool, config);
        if (breakerRejection) {
          log.warn(
            { tool: tool.name },
            "circuit breaker tripped: write refused without approval",
          );
          toolResults.push(breakerRejection);
          continue;
        }
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
    const ordinal = ordinals.get(tool.id);
    toolResults.push({
      tool_use_id: tool.id,
      // UpdateReport's own ack is not evidence; every other read result is citable.
      content:
        ordinal === undefined || tool.name === REPORT_TOOL_SCHEMA.name
          ? content
          : stampEvidence(content, ordinal),
      is_error: result.is_error,
    });
    publishTranscriptItem({
      sessionId,
      item: toolCallCard({
        toolUseId: tool.id,
        toolName: tool.name,
        input: tool.input,
        // The same string the transcript fetch would show, tag stripped, so a
        // reload cannot render this result differently from the live card.
        state: { phase: "complete", result: stripEvidenceTag(content) },
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
