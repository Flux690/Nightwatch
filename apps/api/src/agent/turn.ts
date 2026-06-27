import { executeTool } from "./tools.js";
import type { Tool, ToolExecuteContext } from "./tools.js";
import { mismatchedServiceProvider } from "./policy.js";
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
  // message is answered (D10) even when a later one suspends the run.
  toolResults: ToolResult[];
  // The single gated (write/ask) tool to suspend on, or null if the turn had
  // none. At most one per turn; subsequent gated tools are rejected inline.
  gated: GatedTool | null;
}

// Process one assistant turn's tool calls in two passes (D9, D10): execute every
// non-gated read immediately and accumulate its result, and pick out the first
// gated (write/ask) tool for the loop to suspend on. Reads resolve against the
// effective tool set, so a tool stripped by remediation mode or fleet providers
// is reported unavailable rather than executed.
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
    // Resolve against the effective tool set, not the full registry: a tool
    // stripped by remediation mode or fleet providers is genuinely unavailable,
    // so a model that names it is told "unavailable" and never reaches the
    // approval gate. This is what makes the master write switch unbypassable.
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
        // tool_use in this assistant message still gets a tool_result (D10).
        toolResults.push({
          tool_use_id: tool.id,
          content: "Another gated action is pending. Retry after it resolves.",
          is_error: true,
        });
        continue;
      }

      if (entry.access === "write") {
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
