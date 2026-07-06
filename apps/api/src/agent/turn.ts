import { executeTool } from "./tools/toolset.js";
import type { Tool, ToolExecuteContext } from "./tools/types.js";
import {
  mismatchedServiceProvider,
  targetRemediationDisabled,
} from "./policy.js";
import { circuitBreakerRejection } from "./breaker.js";
import { publishToolCallStart, publishToolCallEnd } from "../session/stream.js";
import type { logger } from "../logger.js";
import type { AgentConfig } from "@nightwatch/shared";
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

// Process a turn's tool calls in two passes: run every non-gated read now and
// accumulate, and pick the first gated (write/ask) tool for the loop to suspend on. Reads
// resolve against the effective set, so a stripped tool is reported unavailable.
export async function processToolUses(params: {
  toolUses: ToolUse[];
  toolset: Tool[];
  sessionId: string;
  execCtx: ToolExecuteContext;
  config: AgentConfig;
  log: typeof logger;
}): Promise<TurnOutcome> {
  const { toolUses, toolset, sessionId, execCtx, config, log } = params;

  const toolResults: ToolResult[] = [];
  let gatedTool: ToolUse | null = null;
  let gatedEntry: Tool | null = null;

  for (const tool of toolUses) {
    // Resolve against the effective set, not the full registry: a tool stripped by remediation
    // mode or fleet providers is genuinely unavailable, so a model naming it never reaches the
    // gate. This is what makes the master write switch unbypassable.
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

    const mismatchedProvider = mismatchedServiceProvider(tool.input, entry);
    if (mismatchedProvider) {
      log.warn(
        { tool: tool.name, provider: mismatchedProvider },
        "provider-specific tool called with mismatched service identity",
      );
      toolResults.push({
        tool_use_id: tool.id,
        content: `Provider mismatch: "${tool.name}" only supports [${(entry.providers ?? []).join(", ")}], but was called with a "${mismatchedProvider}" service identity. Echo the service identity as received; use an agnostic tool, or a tool matching that provider, instead. Do not retry this call as-is.`,
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
        // Per-target gate: a write against a machine whose remediation is off
        // is rejected before waking a human - the switch belongs to the
        // target, not to the session that proposed the write.
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
    publishToolCallStart({
      sessionId,
      toolUseId: tool.id,
      toolName: tool.name,
      input: tool.input,
    });
    const result = await executeTool(entry, tool.input, execCtx);
    toolResults.push({
      tool_use_id: tool.id,
      content:
        typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content),
      is_error: result.is_error,
    });
    publishToolCallEnd({
      sessionId,
      toolUseId: tool.id,
      result: result.content,
      isError: result.is_error,
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
