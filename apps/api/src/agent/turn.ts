import { executeTool, resolvePolicy } from "./tools/toolset.js";
import { parseInput } from "./tools/schema.js";
import type { OfferedToolset } from "./tools/toolset.js";
import type { Tool, ToolDispatchContext } from "./tools/types.js";
import { publishTranscriptItem } from "../session/stream.js";
import { toolCallCard } from "../session/transcript.js";
import type { logger } from "../logger.js";
import type { ToolResult, ToolUse } from "../llm/types.js";
import { isToolName } from "@nightwarden/shared";

// Which interrupt a gated call raises. An elicitation always raises one; a tool
// raises one only when the user's policy says a human must permit it.
type GateKind = "approval" | "clarification";

interface TurnOutcome {
  // One per non-gated tool_use, so every block is answered even when a later one
  // suspends. Each carries whether its tool failed, which the record stores.
  toolResults: ToolResult[];
  // The single gated call to suspend on, or null if the turn had none. The turn
  // suspends there, so every call asked for after it is answered for reissue.
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

// Answered for every call asked for after the turn's gated one: the run suspends
// there, so each is reissued next turn once the gate resolves.
function notRunAfterGate(callName: string, gatedName: string): string {
  return `${callName} did not run. Earlier in this turn ${gatedName} paused the run to wait for you, so the run stopped before ${callName}. Call ${callName} again in your next turn, once ${gatedName} is resolved.`;
}

/* One step per tool_use, decided before anything runs. A gate contributes no
   result: the loop suspends on it and the resume answers it. */
type Step =
  | { kind: "answer"; result: ToolResult }
  | { kind: "gate" }
  | { kind: "run"; call: ToolUse; tool: Tool };

// Two passes: classify every call with no I/O, so the one-gate-per-turn rule keeps its
// order, then run them. Both resolve against the offered set, so a stripped tool reports unavailable.
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

  const steps: Step[] = [];
  const refused: string[] = [];
  let gated: { tool: ToolUse; kind: GateKind } | null = null;
  const offeredNames = [
    ...offered.tools.map((t) => t.schema.name),
    ...offered.elicitations.map((e) => e.schema.name),
  ];

  for (const tool of toolUses) {
    // A gated call suspends the whole turn, so nothing asked for after it runs;
    // each is answered here so the model can reissue it once the gate resolves.
    if (gated !== null) {
      steps.push({
        kind: "answer",
        result: {
          toolCallId: tool.toolCallId,
          content: notRunAfterGate(tool.name, gated.tool.name),
          isError: true,
        },
      });
      continue;
    }

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
          steps.push({
            kind: "answer",
            result: {
              toolCallId: tool.toolCallId,
              content: parsed.failure.content,
              isError: true,
            },
          });
          continue;
        }
        gated = { tool, kind: "clarification" };
        steps.push({ kind: "gate" });
        continue;
      }
      refused.push(tool.name);
      const asked = params.alreadyRefused.get(tool.name) ?? 0;
      log.warn(
        { tool: tool.name, exists: isToolName(tool.name), asked: asked + 1 },
        "LLM requested unavailable tool",
      );
      steps.push({
        kind: "answer",
        result: {
          toolCallId: tool.toolCallId,
          content: unavailableMessage(tool.name, offeredNames, asked + 1),
          isError: true,
        },
      });
      continue;
    }

    if (resolvePolicy(entry, tool.input) === "approve") {
      gated = { tool, kind: "approval" };
      steps.push({ kind: "gate" });
      continue;
    }

    steps.push({ kind: "run", call: tool, tool: entry });
  }

  const runOne = async (call: ToolUse, tool: Tool): Promise<ToolResult> => {
    publishTranscriptItem({
      sessionId,
      item: toolCallCard({
        toolCallId: call.toolCallId,
        toolName: call.name,
        input: call.input,
        state: { phase: "running" },
      }),
    });
    const { content, isError } = await executeTool(tool, call.input, {
      ...execCtx,
      toolCallId: call.toolCallId,
    });
    publishTranscriptItem({
      sessionId,
      item: toolCallCard({
        toolCallId: call.toolCallId,
        toolName: call.name,
        input: call.input,
        // The same string the transcript fetch would show, so a reload cannot
        // render this result differently from the live card.
        state: {
          phase: "complete",
          result: content,
          ...(isError === true && { isError: true }),
        },
      }),
    });
    return {
      toolCallId: call.toolCallId,
      content,
      ...(isError === true && { isError: true }),
    };
  };

  const isRead = (step: Step): boolean =>
    step.kind === "run" && step.tool.effect === "read";

  /* Filled by index, so a result keeps the position its call was emitted in and
     the evidence ids the loop stamps cannot move with the timing. */
  const answers: Array<ToolResult | undefined> = new Array<
    ToolResult | undefined
  >(steps.length);
  let i = 0;
  while (i < steps.length) {
    const step = steps[i]!;
    if (step.kind === "answer") answers[i] = step.result;
    if (step.kind !== "run") {
      i++;
      continue;
    }
    if (!isRead(step)) {
      answers[i] = await runOne(step.call, step.tool);
      i++;
      continue;
    }
    /* A run of reads contends for nothing, so it goes out together. Emission
       order is never crossed: a write still separates the reads around it. */
    let end = i;
    while (end < steps.length && isRead(steps[end]!)) end++;
    const batch = steps.slice(i, end) as Array<Extract<Step, { kind: "run" }>>;
    const ran = await Promise.all(
      batch.map(async (s) => await runOne(s.call, s.tool)),
    );
    ran.forEach((result, offset) => {
      answers[i + offset] = result;
    });
    i = end;
  }

  const toolResults = answers.flatMap((r) => (r === undefined ? [] : [r]));

  return { toolResults, gated, refused };
}
