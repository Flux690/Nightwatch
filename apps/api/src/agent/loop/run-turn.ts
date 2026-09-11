import { METRICS_SOURCE_KINDS } from "@nightwarden/shared";
import type { ToolName } from "@nightwarden/shared";
import type { ToolDispatchContext } from "../tools/types.js";
import {
  effectiveToolset,
  offeredSchemas,
  type OfferedToolset,
} from "../tools/toolset.js";
import { connectedPlatforms } from "../policy.js";
import { connectedKinds } from "../../integrations/store.js";
import { getRecord } from "../../session/record-store.js";
import { recoveryState } from "../../verification/recovery.js";
import {
  approvedWriteCount,
  gatedCalls,
  openCandidateIds,
  recordGaps,
  reportIsBehind,
  setLastStatedCandidates,
  toolCallsIn,
} from "../report.js";
import {
  CANDIDATES_OPENING_MESSAGE,
  falsificationMessage,
  frontierMessage,
} from "../prompts/report.js";
import { appendErrorMessage } from "../../session/transcript-store.js";
import {
  publishInterrupt,
  publishTranscriptItem,
} from "../../session/stream.js";
import { toolCallCard } from "../../session/transcript.js";
import type { PendingHumanInput } from "../../session/gate-store.js";
import type {
  ChatResponse,
  ToolResult,
  ToolSchema,
  ToolUse,
} from "../../llm/types.js";
import { processToolUses } from "./turn.js";
import { turnEnding } from "./endings.js";
import { citableAnswers } from "./guardrails.js";
import { formatInjectedAlerts } from "./injection.js";
import { composeReportTurn } from "./report-turn.js";
import type { RunContext, TurnResult } from "./run-state.js";

// What the fleet and the connected integrations currently allow. Read together,
// because the prompt describing them is built from the same call.
export async function currentToolset(
  investigation: boolean,
): Promise<OfferedToolset> {
  const kinds = await connectedKinds();
  return effectiveToolset(
    connectedPlatforms(),
    {
      github: kinds.has("github"),
      metrics: METRICS_SOURCE_KINDS.some((k) => kinds.has(k)),
      loki: kinds.has("loki"),
      sentry: kinds.has("sentry"),
    },
    investigation,
  );
}

// Names only the difference: a run thirty turns deep does not need its whole
// toolset restated, and each tool already carries its own description.
function toolsetChange(
  before: OfferedToolset,
  after: OfferedToolset,
): string | null {
  const was = new Set(before.tools.map((t) => t.schema.name));
  const now = new Set(after.tools.map((t) => t.schema.name));
  const gained = [...now].filter((n) => !was.has(n));
  const lost = [...was].filter((n) => !now.has(n));
  if (gained.length === 0 && lost.length === 0) return null;
  const lines: string[] = [];
  if (gained.length > 0) {
    lines.push(
      `Something connected while you were working, so these tools are available to you now: ${gained.join(", ")}.`,
    );
  }
  if (lost.length > 0) {
    lines.push(
      `Something disconnected while you were working, so these tools are no longer available and calling one will be refused: ${lost.join(", ")}. Anything they already told you stays on the record.`,
    );
  }
  return lines.join(" ");
}

type Gate = { tool: ToolUse; kind: "approval" | "clarification" };

// Durably suspend on a gated call: persist the assistant turn and the interrupt
// row in one transaction, then tell the frontend a human is needed.
async function suspendOnGate(
  ctx: RunContext,
  gated: Gate,
  toolResults: ToolResult[],
): Promise<void> {
  const { sessionId, log } = ctx;
  const isAskGate = gated.kind === "clarification";
  const interrupt: PendingHumanInput = {
    sessionId,
    toolCallId: gated.tool.toolCallId,
    kind: isAskGate ? "clarification" : "approval",
    completedResults: toolResults,
    claimedAt: null,
  };
  await ctx.state.flush(interrupt);
  const clarInput = isAskGate
    ? (gated.tool.input as {
        question: string;
        options: Array<{ label: string; description: string }>;
        multiSelect?: boolean;
      })
    : null;
  publishTranscriptItem({
    sessionId,
    item: toolCallCard({
      toolCallId: gated.tool.toolCallId,
      toolName: gated.tool.name,
      input: gated.tool.input,
      state: {
        phase: "awaiting_human",
        gate: isAskGate ? "clarification" : "approval",
      },
    }),
  });
  publishInterrupt({
    sessionId,
    toolCallId: gated.tool.toolCallId,
    toolName: gated.tool.name,
    input: gated.tool.input,
    kind: isAskGate ? "clarification" : "approval",
    ...(clarInput !== null && {
      question: clarInput.question,
      options: clarInput.options,
      multiSelect: clarInput.multiSelect,
    }),
  });
  log.info(
    { tool: gated.tool.name, kind: interrupt.kind },
    "run suspended: pending human input",
  );
}

// Keeps the open candidates in view whenever the set changes, so the ones still
// to test are not lost behind a long chain of reads. The set is read live.
async function emitFrontierIfChanged(ctx: RunContext): Promise<void> {
  const record = await getRecord(ctx.sessionId);
  if (record === undefined) return;
  const open = openCandidateIds(record);
  const last = record.lastStatedCandidates;
  const same =
    open.length === last.length &&
    [...open].sort().join("\n") === [...last].sort().join("\n");
  if (same) return;
  await setLastStatedCandidates(ctx.sessionId, open);
  if (open.length > 0) ctx.state.sendSystemReminder(frontierMessage(record));
}

// One turn of the loop: send the conversation, read what came back, and tell the
// driver to loop, break to the continue-request, or end with an outcome.
export async function runOneTurn(ctx: RunContext): Promise<TurnResult> {
  const { state, sessionId, log, llm } = ctx;
  const turn = (state.turn += 1);

  // Re-read per turn, but never silently: a change the model is not told about
  // looks to it like the rules moved, and the prompt is never revised.
  const nowOffered = await currentToolset(ctx.opensInvestigation);
  const change = toolsetChange(state.offered, nowOffered);
  if (change !== null) {
    log.info({ turn, change }, "offered toolset changed mid-run");
    state.offered = nowOffered;
    state.sendSystemReminder(change);
    await state.flush();
  }

  // Once evidence has answered and no candidates are open, the run weighs
  // explanations together before it looks further, forced so it cannot skip them.
  const forceCandidates =
    ctx.opensInvestigation &&
    !state.candidatesOpened &&
    state.hasAnsweredCitable;
  let toolSchemas: ToolSchema[];
  let forceTool: ToolName | undefined;
  if (forceCandidates) {
    state.sendSystemReminder(CANDIDATES_OPENING_MESSAGE);
    await state.flush();
    toolSchemas = offeredSchemas(state.offered).filter(
      (s) => s.name === "OpenCandidates",
    );
    forceTool = "OpenCandidates";
  } else {
    toolSchemas = offeredSchemas(state.offered);
  }

  const startedAt = Date.now();
  let response: ChatResponse;
  try {
    response = await ctx.chat(
      state.conversation(),
      toolSchemas,
      state.nextSeq,
      ctx.runSignal,
      forceTool,
    );
    state.stage("assistant", response.parts);
  } catch (err) {
    if (ctx.signal?.aborted) {
      log.info({ turn }, "run stopped by user");
      await state.flush();
      return { kind: "outcome", outcome: "stopped" };
    }
    // The budget cut the turn short. That is the check-in, not a failure, so it
    // leaves the loop rather than killing the run.
    if (ctx.outOfTime.aborted) {
      log.info({ turn }, "time budget reached mid-turn");
      await state.flush();
      return { kind: "budget" };
    }
    throw err;
  }
  if (ctx.signal?.aborted) {
    log.info({ turn }, "run stopped by user");
    await state.flush();
    return { kind: "outcome", outcome: "stopped" };
  }
  log.info(
    {
      turn,
      ms: Date.now() - startedAt,
      stopReason: response.stopReason,
      toolUses: response.toolUses.map((t) => t.name),
    },
    "LLM responded",
  );
  await state.flush();

  /* Without an error row the session derives to completed and a turn that
     answered nothing is invisible, so the ending is said in the transcript. */
  const ending = turnEnding(response.stopReason, llm.maxOutputTokens);
  if (ending !== null) {
    log.warn(
      { turn, model: llm.model, stopReason: response.stopReason },
      "turn ended without an answer",
    );
    await appendErrorMessage(sessionId, ending);
    return { kind: "outcome", outcome: "completed" };
  }

  if (response.toolUses.length === 0) {
    if (!ctx.opensInvestigation) {
      log.info({ turn }, "chat finished with free-form response");
      return { kind: "outcome", outcome: "completed" };
    }
    const gaps = await recordGaps(sessionId);
    // Read, not asked: the reconciler and the resolved webhook both stamp the
    // record, so the gate never makes a network call as a run happens to end.
    const recovery = await recoveryState(sessionId);
    if (gaps.length > 0) {
      const pushback = ctx.finishGate(gaps);
      if (pushback !== null) {
        log.info(
          { turn, gap: pushback.kind, count: pushback.count, recovery },
          "finish gate: record incomplete, pushing back",
        );
        state.sendSystemReminder(pushback.say);
        await state.flush();
        return { kind: "continue" };
      }
      log.warn(
        { turn, gaps: gaps.map((g) => g.kind), recovery },
        "finish gate: request cap reached, writing up incomplete",
      );
    }
    // The last look, when there are candidates to challenge: test what would
    // disprove each finding that still stands before the report is composed.
    const record = await getRecord(sessionId);
    if (
      !state.falsificationOffered &&
      record !== undefined &&
      record.candidates.length > 0
    ) {
      state.falsificationOffered = true;
      state.sendSystemReminder(falsificationMessage(record));
      await state.flush();
      return { kind: "continue" };
    }
    // Only a run that acted must recommend: ruling things out is a complete
    // ending, but releasing a write and going quiet leaves the user nothing.
    const gated = gatedCalls(await toolCallsIn(sessionId));
    const approvedWrites = approvedWriteCount(gated);
    /* Rewriting is lossy, so a write-up that still covers the record is kept.
       Recovery is not a reason: a cleared alert already reads as Resolved. */
    if (record !== undefined && !reportIsBehind(record, approvedWrites)) {
      log.info({ turn }, "write-up still covers the record; keeping it");
      return { kind: "outcome", outcome: "completed" };
    }
    return {
      kind: "outcome",
      outcome: await composeReportTurn(
        ctx,
        approvedWrites > 0 && recovery === "unconfirmed",
        gated,
      ),
    };
  }

  const execCtx: Omit<ToolDispatchContext, "toolCallId"> = {
    // Already clamped by what remains of the investigation, so no tool call can
    // outlive the budget it is being spent from.
    toolCallCeilingMs: Math.max(
      0,
      Math.min(ctx.toolCallCeilingMs, ctx.deadline - Date.now()),
    ),
    sessionId,
  };

  const { toolResults, gated, refused } = await processToolUses({
    toolUses: response.toolUses,
    offered: state.offered,
    sessionId,
    execCtx,
    log,
    alreadyRefused: state.refusedNames,
  });
  for (const name of refused) {
    state.refusedNames.set(name, (state.refusedNames.get(name) ?? 0) + 1);
  }

  const barren = ctx.barrenTurns(
    response.toolUses.length,
    refused.length,
    state.offered,
  );
  if (barren !== null) {
    log.warn(
      { turn, refused: [...state.refusedNames.keys()] },
      "run asked only for unavailable tools; ending it",
    );
    state.stageResults(response.toolUses, toolResults);
    await state.flush();
    await appendErrorMessage(sessionId, barren);
    return { kind: "outcome", outcome: "completed" };
  }

  // A turn's tools outlive the stop that arrives during them, so the gate is
  // reached already aborted; suspending here parks an interrupt on a dead run.
  if (ctx.signal?.aborted) {
    log.info({ turn }, "run stopped by user before the gate");
    await state.flush();
    return { kind: "outcome", outcome: "stopped" };
  }

  if (gated !== null) {
    // Suspended sessions take no injections, so the inbox is not drained here.
    await suspendOnGate(ctx, gated, toolResults);
    return { kind: "outcome", outcome: "suspended" };
  }

  // Drained at the tool boundary, the earliest point the model can act on one,
  // as their own turn after the results.
  state.stageResults(response.toolUses, toolResults);
  if (response.toolUses.some((t) => t.name === "OpenCandidates")) {
    state.candidatesOpened = true;
  }
  // Already durable: the dispatcher wrote each one when it arrived. The inbox
  // exists to tell the model, which is a separate concern from keeping it.
  const injected = ctx.drainInbox?.(sessionId) ?? [];
  if (injected.length > 0) {
    state.sendSystemReminder(formatInjectedAlerts(injected));
  }

  await emitFrontierIfChanged(ctx);

  const claims = ((await getRecord(sessionId))?.findings ?? []).length;
  const ask = ctx.recordDebt.check(
    claims,
    citableAnswers(response.toolUses, toolResults),
  );
  if (ask !== null) {
    log.info({ turn }, "reads unaccounted for; asking");
    state.sendSystemReminder(ask);
  }
  await state.flush();
  return { kind: "continue" };
}
