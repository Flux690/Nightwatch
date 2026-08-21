import { executeTool, resolvePolicy } from "./tools/toolset.js";
import { questionOptionOverflow } from "./tools/elicitations.js";
import { isToolFailure } from "./tools/types.js";
import type { OfferedToolset } from "./tools/toolset.js";
import type { ToolDispatchContext } from "./tools/types.js";
import { publishTranscriptItem } from "../session/stream.js";
import { toolCallCard } from "../session/transcript.js";
import type { logger } from "../logger.js";
import type { ToolResult, ToolUse } from "../llm/types.js";
import { getTranscriptRows } from "../db/sessions.js";
import { countToolCalls } from "./evidence-id.js";
import { isToolName } from "@nightwarden/shared";

// Which interrupt a gated call raises. An elicitation always raises one; a tool
// raises one only when the user's policy says a human must permit it.
type GateKind = "approval" | "clarification";

interface TurnOutcome {
  // One per non-gated tool_use, so every block is answered even when a later one
  // suspends. Each carries its toolOutcome, which the loop stamps onto the part.
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

/* Three facts, because one sentence covered two situations: a real tool
   withheld for want of a runner, and a name that never existed. Told the same
   thing, a model guesses which by working through the namespace. */
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
  return `${what}${suggestion}${repeat} Do not ask for it again. What you do have is: ${offered.join(", ")}.`;
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
  // How many times each name has already been refused in this run, so a repeat
  // is answered as a repeat rather than as a fresh mistake.
  alreadyRefused: ReadonlyMap<string, number>;
}): Promise<TurnOutcome> {
  const { toolUses, offered, sessionId, execCtx, log } = params;

  /* Numbered from what the transcript already holds plus this turn's position:
     the calls in flight are not persisted yet, and the ledger walk that resolves
     a citation later counts the same way. */
  let nextEvidence = countToolCalls(getTranscriptRows(sessionId));
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
        tool_use_id: call.id,
        content: "Another gated action is pending. Retry after it resolves.",
        is_error: true,
        toolOutcome: "system",
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
        // The schema declares the cap; providers honour maxItems unevenly.
        // Nothing suspends, because nothing valid arrived.
        const overflow = questionOptionOverflow(tool.input);
        if (overflow !== null) {
          toolResults.push({
            tool_use_id: tool.id,
            content: overflow,
            is_error: true,
            toolOutcome: "system",
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
        tool_use_id: tool.id,
        content: unavailableMessage(tool.name, offeredNames, asked + 1),
        is_error: true,
        toolOutcome: "system",
      });
      continue;
    }

    if (resolvePolicy(entry, tool.input) === "approve") {
      // Consumes its number even though it runs later, so nothing after it in
      // this turn renumbers when the human answers.
      nextEvidence += 1;
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
    nextEvidence += 1;
    const { content, toolOutcome } = await executeTool(entry, tool.input, {
      ...execCtx,
      toolUseId: tool.id,
      evidenceId: `e${nextEvidence}`,
    });
    toolResults.push({
      tool_use_id: tool.id,
      content,
      is_error: isToolFailure(toolOutcome),
      ...(toolOutcome !== undefined && { toolOutcome }),
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
          ...(toolOutcome !== undefined && { toolOutcome }),
        },
      }),
    });
  }

  return { toolResults, gated, refused };
}
