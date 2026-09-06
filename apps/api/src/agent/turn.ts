import { executeTool, resolvePolicy } from "./tools/toolset.js";
import { parseInput } from "./tools/schema.js";
import type { OfferedToolset } from "./tools/toolset.js";
import type { ToolDispatchContext } from "./tools/types.js";
import { publishTranscriptItem } from "../session/stream.js";
import { toolCallCard } from "../session/transcript.js";
import type { logger } from "../logger.js";
import type { ToolResult, ToolUse } from "../llm/types.js";
import { getTranscriptRows } from "../session/transcript-store.js";
import { evidenceIdsIn } from "./evidence-id.js";
import { isToolName } from "@nightwarden/shared";

// Which interrupt a gated call raises. An elicitation always raises one; a tool
// raises one only when the user's policy says a human must permit it.
type GateKind = "approval" | "clarification";

interface TurnOutcome {
  // One per non-gated tool_use, so every block is answered even when a later one
  // suspends. Each carries whether its tool failed, which the record stores.
  toolResults: ToolResult[];
  // The single gated call to suspend on, or null if the turn had none. At most
  // one per turn; subsequent gated calls are rejected inline.
  gated: { tool: ToolUse; kind: GateKind } | null;
  // Names this turn asked for and did not get. The loop counts them across
  // turns, because one turn cannot see that it is the fourth to ask.
  refused: string[];
}

// Edits between two names, for the did-you-mean below. Small and local: the
// alternative is a dependency for one screenful of arithmetic.
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

// The offered name closest to what was asked for, or null when nothing is near.
// Every invented name in the observed run was one word from a real one.
function nearestOffered(wanted: string, offered: string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const name of offered) {
    const distance = editDistance(wanted.toLowerCase(), name.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  if (best === null) return null;
  return bestDistance <= Math.max(wanted.length, best.length) * 0.4
    ? best
    : null;
}

// Three facts, because one sentence covered both a tool withheld for want of
// a runner and a name that never existed, leaving the model to guess.
function unavailableMessage(
  wanted: string,
  offered: string[],
  asked: number,
): string {
  const exists = isToolName(wanted);
  const what = exists
    ? `"${wanted}" is a real tool, but it is not available in this investigation: whatever it needs - a Docker host, a Kubernetes cluster, or a connected integration - is not there.`
    : `There is no tool called "${wanted}", in this investigation or anywhere in NightWarden.`;
  const near = nearestOffered(wanted, offered);
  const suggestion = near === null ? "" : ` Did you mean ${near}?`;
  const repeat =
    asked > 1
      ? ` You have now asked for it ${asked} times; the answer will not change.`
      : "";
  return `${what}${suggestion}${repeat} Do not ask for it again. What you do have: ${offered.join(", ")}.`;
}

// Two passes: run every unapproved tool now, and pick the first call needing a human for
// the loop to suspend on. Both resolve against the offered set, so a stripped tool reports unavailable.
export async function processToolUses(params: {
  toolUses: ToolUse[];
  offered: OfferedToolset;
  sessionId: string;
  // The id is per call, so the loop hands over a turn-scoped base context and
  // each execution below completes it with its own.
  execCtx: Omit<ToolDispatchContext, "toolCallId">;
  log: typeof logger;
  // How many times each name has already been refused in this run, so a repeat
  // is answered as a repeat rather than as a fresh mistake.
  alreadyRefused: ReadonlyMap<string, number>;
}): Promise<TurnOutcome> {
  const { toolUses, offered, sessionId, execCtx, log } = params;

  // The trail's own numbering: this turn is already persisted when it runs, so
  // a count of our own would name every result a turn ahead of itself.
  const evidenceIds = evidenceIdsIn(await getTranscriptRows(sessionId));
  const toolResults: ToolResult[] = [];
  const refused: string[] = [];
  let gated: { tool: ToolUse; kind: GateKind } | null = null;
  const offeredNames = [
    ...offered.tools.map((t) => t.schema.name),
    ...offered.elicitations.map((e) => e.schema.name),
  ];

  // Only one gate per turn, so every tool_use in this assistant message still
  // gets a tool_result rather than the conversation being left unanswerable.
  const gateOrReject = (call: ToolUse, kind: GateKind): void => {
    if (gated !== null) {
      toolResults.push({
        toolCallId: call.toolCallId,
        content: "Another gated action is pending. Retry after it resolves.",
        isError: true,
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
      const elicitation = offered.elicitations.find(
        (e) => e.schema.name === tool.name,
      );
      if (elicitation) {
        // Parsed here because an elicitation has no execute to parse in, and
        // nothing suspends until a valid question has arrived.
        const parsed = parseInput(elicitation.input, tool.input);
        if (!parsed.ok) {
          toolResults.push({
            toolCallId: tool.toolCallId,
            content: parsed.failure.content,
            isError: true,
          });
          continue;
        }
        gateOrReject(tool, "clarification");
        continue;
      }
      refused.push(tool.name);
      const asked = params.alreadyRefused.get(tool.name) ?? 0;
      log.warn(
        { tool: tool.name, exists: isToolName(tool.name), asked: asked + 1 },
        "LLM requested unavailable tool",
      );
      toolResults.push({
        toolCallId: tool.toolCallId,
        content: unavailableMessage(tool.name, offeredNames, asked + 1),
        isError: true,
      });
      continue;
    }

    if (resolvePolicy(entry, tool.input) === "approve") {
      // Nothing to reserve: the approve path reads the same walk.
      gateOrReject(tool, "approval");
      continue;
    }

    publishTranscriptItem({
      sessionId,
      item: toolCallCard({
        toolCallId: tool.toolCallId,
        toolName: tool.name,
        input: tool.input,
        state: { phase: "running" },
      }),
    });
    const evidenceId = evidenceIds.get(tool.toolCallId);
    const { content, isError } = await executeTool(entry, tool.input, {
      ...execCtx,
      toolCallId: tool.toolCallId,
      ...(evidenceId !== undefined && { evidenceId }),
    });
    toolResults.push({
      toolCallId: tool.toolCallId,
      content,
      ...(isError === true && { isError: true }),
    });
    publishTranscriptItem({
      sessionId,
      item: toolCallCard({
        toolCallId: tool.toolCallId,
        toolName: tool.name,
        input: tool.input,
        // The same string the transcript fetch would show, so a reload cannot
        // render this result differently from the live card.
        state: {
          phase: "complete",
          result: content,
          ...(isError === true && { isError: true }),
        },
      }),
    });
  }

  return { toolResults, gated, refused };
}
