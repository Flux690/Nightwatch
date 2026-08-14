import { executeTool, resolvePolicy } from "./tools/toolset.js";
import { isToolFailure } from "./tools/types.js";
import type { OfferedToolset } from "./tools/toolset.js";
import type { ToolDispatchContext } from "./tools/types.js";
import { publishTranscriptItem } from "../session/stream.js";
import { toolCallCard } from "../session/transcript.js";
import type { logger } from "../logger.js";
import type { ToolResult, ToolUse } from "../llm/types.js";

// Which interrupt a gated call raises. An elicitation always raises one; a tool
// raises one only when the user's policy says a human must permit it.
type GateKind = "approval" | "clarification";

interface TurnOutcome {
  /* One tool_result per non-gated tool_use, so every block in the assistant
     message is answered even when a later one suspends the run. Each carries
     its own outcome, which is what the loop stamps onto the persisted part -
     the provider round-trip in between has nowhere to put it. */
  toolResults: ToolResult[];
  // The single gated call to suspend on, or null if the turn had none. At most
  // one per turn; subsequent gated calls are rejected inline.
  gated: { tool: ToolUse; kind: GateKind } | null;
}

// Two passes: run every unapproved tool now, and pick the first call needing a human for
// the loop to suspend on. Both resolve against the offered set, so a stripped tool reports unavailable.
export async function processToolUses(params: {
  toolUses: ToolUse[];
  offered: OfferedToolset;
  sessionId: string;
  // toolUseId is per call, so the loop hands over a turn-scoped base context
  // and each execution below completes it with its own tool_use id.
  execCtx: Omit<ToolDispatchContext, "toolUseId">;
  log: typeof logger;
}): Promise<TurnOutcome> {
  const { toolUses, offered, sessionId, execCtx, log } = params;

  const toolResults: ToolResult[] = [];
  let gated: { tool: ToolUse; kind: GateKind } | null = null;

  // Only one gate per turn, so every tool_use in this assistant message still
  // gets a tool_result rather than the conversation being left unanswerable.
  const gateOrReject = (call: ToolUse, kind: GateKind): void => {
    if (gated !== null) {
      toolResults.push({
        tool_use_id: call.id,
        content: "Another gated action is pending. Retry after it resolves.",
        is_error: true,
        outcome: "system",
      });
      return;
    }
    gated = { tool: call, kind };
  };

  for (const tool of toolUses) {
    // Resolve against the effective set, not the full registry, so a tool stripped
    // by fleet providers or integrations never reaches the gate.
    const entry = offered.tools.find((t) => t.schema.name === tool.name);

    if (!entry) {
      // Nothing to execute either way: an elicitation's answer comes from a
      // person, so it suspends rather than running.
      if (offered.elicitations.some((e) => e.schema.name === tool.name)) {
        gateOrReject(tool, "clarification");
        continue;
      }
      log.warn({ tool: tool.name }, "LLM requested unavailable tool");
      toolResults.push({
        tool_use_id: tool.id,
        content: `Tool "${tool.name}" is not available in this investigation. Do not retry.`,
        is_error: true,
        outcome: "system",
      });
      continue;
    }

    if (resolvePolicy(entry, tool.input) === "approve") {
      gateOrReject(tool, "approval");
      continue;
    }

    publishTranscriptItem({
      sessionId,
      item: toolCallCard({
        toolUseId: tool.id,
        toolName: tool.name,
        input: tool.input,
        state: { phase: "running" },
      }),
    });
    const { content, outcome } = await executeTool(entry, tool.input, {
      ...execCtx,
      toolUseId: tool.id,
    });
    toolResults.push({
      tool_use_id: tool.id,
      content,
      is_error: isToolFailure(outcome),
      ...(outcome !== undefined && { outcome }),
    });
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
          ...(outcome !== undefined && { outcome }),
        },
      }),
    });
  }

  return { toolResults, gated };
}
