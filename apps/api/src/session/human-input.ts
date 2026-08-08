import {
  claimPendingHumanInput,
  deletePendingHumanInput,
  getPendingHumanInputBySessionId,
} from "../db/interrupts.js";
import { recordToolOutcome } from "../db/tool-outcomes.js";
import { findToolCall } from "../db/sessions.js";
import { loadConfig } from "../config/store.js";
import { dispatcher } from "../dispatcher.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { publishInterruptResolved, publishTranscriptItem } from "./stream.js";
import { toolCallCard } from "./transcript.js";
import { buildSeed } from "./seed.js";
import { executeApprovedTool } from "./approval-executor.js";
import type {
  ApprovalResponse,
  RespondRequest,
  ToolOutcome,
} from "@nightwarden/shared";

export class HumanInputError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface HumanInputActionResult extends ApprovalResponse {
  sessionId: string;
}

function requirePendingHumanInput(sessionId: string) {
  const pending = getPendingHumanInputBySessionId(sessionId);
  if (!pending) {
    throw new HumanInputError(
      409,
      `No pending human input for session: ${sessionId}`,
    );
  }
  return pending;
}

// The interrupt names the gated call; the transcript says what it was, and the
// two are written in one transaction. A miss here is a contradiction, not a
// case to carry forward with an empty tool name.
function requireGatedCall(
  sessionId: string,
  toolUseId: string,
): { name: string; input: Record<string, unknown> } {
  const call = findToolCall(sessionId, toolUseId);
  if (!call) {
    throw new HumanInputError(
      409,
      `No tool call ${toolUseId} in session ${sessionId}`,
    );
  }
  return call;
}

/* The claim is a compare-and-swap, so a failure means someone else holds it -
   either a request still in flight, or a process that died holding it. Age tells
   them apart: nothing legitimate holds a claim for longer than the ceiling a tool
   call is allowed, because the request would have returned by then.

   "stale" is the crash-recovery path, and it is why the claim is never cleared at
   boot: the write may have run before the process died and nothing recorded
   whether it did. Running it again is the one thing we must not do. */
function claim(sessionId: string, claimedAt: string | null): "held" | "stale" {
  if (claimPendingHumanInput(sessionId)) return "held";
  const heldForMs =
    claimedAt === null ? 0 : Date.now() - new Date(claimedAt).getTime();
  if (heldForMs <= loadConfig().toolCallCeilingMs) {
    throw new HumanInputError(
      409,
      "Human input already claimed by another request",
    );
  }
  return "stale";
}

function ensureDeleted(sessionId: string): void {
  if (!deletePendingHumanInput(sessionId)) {
    throw new HumanInputError(
      409,
      "Human input already resolved by another request",
    );
  }
}

function unpause(
  sessionId: string,
  toolUseId: string,
  status: "approved" | "rejected" | "answered",
  resolvedBy: string,
  completedResults: ToolResult[],
  gatedResult: ToolResult,
  card: { toolName: string; input: Record<string, unknown> },
  outcome?: ToolOutcome,
): HumanInputActionResult {
  ensureDeleted(sessionId);

  const resolvedAt = new Date().toISOString();

  publishTranscriptItem({
    sessionId,
    item: toolCallCard({
      toolUseId,
      toolName: card.toolName,
      input: card.input,
      state: {
        phase: "resolved",
        decision: status,
        by: resolvedBy,
        ...(status === "approved" && { result: gatedResult.content }),
        ...(outcome !== undefined && { outcome }),
      },
    }),
  });

  publishInterruptResolved({
    sessionId,
    toolUseId,
    status,
    resolvedBy,
    resolvedAt,
  });

  dispatcher.dispatch({
    sessionId,
    seed: buildSeed(sessionId),
    resumeToolResults: [...completedResults, gatedResult],
  });

  return { sessionId, toolUseId, status, resolvedBy, resolvedAt };
}

export async function respondToPendingHumanInput(
  sessionId: string,
  request: RespondRequest,
  resolvedBy = "console",
): Promise<HumanInputActionResult> {
  const pending = requirePendingHumanInput(sessionId);
  const { decision, text } = request;

  if (pending.kind === "continue") {
    // No async work between resolve and dispatch, so ensureDeleted alone is the
    // concurrency gate; claimOrThrow is skipped since nothing here executes async.
    ensureDeleted(sessionId);
    const resolvedAt = new Date().toISOString();
    if (decision === "reject") {
      publishInterruptResolved({
        sessionId,
        toolUseId: pending.toolUseId,
        status: "rejected",
        resolvedBy,
        resolvedAt,
      });
      logger.info(
        { sessionId, resolvedBy },
        "continue request ended by operator",
      );
      dispatcher.dispatch({
        sessionId,
        seed: buildSeed(sessionId),
        wrapUp: true,
      });
      return {
        sessionId,
        toolUseId: pending.toolUseId,
        status: "rejected",
        resolvedBy,
        resolvedAt,
      };
    }
    publishInterruptResolved({
      sessionId,
      toolUseId: pending.toolUseId,
      status: "continued",
      resolvedBy,
      resolvedAt,
    });
    logger.info(
      { sessionId, resolvedBy },
      "continue request resumed by operator",
    );
    dispatcher.dispatch({ sessionId, seed: buildSeed(sessionId) });
    return {
      sessionId,
      toolUseId: pending.toolUseId,
      status: "continued",
      resolvedBy,
      resolvedAt,
    };
  }

  // Everything past the continue branch gates on a real tool call.
  const call = requireGatedCall(sessionId, pending.toolUseId);

  // Before the claim, so a malformed request is refused without taking the lock
  // and wedging the interrupt for the well-formed retry behind it.
  const answer = text?.trim() ?? "";
  if (pending.kind === "clarification") {
    if (decision !== undefined) {
      throw new HumanInputError(
        400,
        "Clarification interrupts do not accept a decision; send text only",
      );
    }
    if (answer === "") {
      throw new HumanInputError(400, "text is required for clarification");
    }
  } else if (decision !== "approve" && decision !== "reject") {
    throw new HumanInputError(
      400,
      "an approval requires a decision of approve or reject",
    );
  }

  if (claim(sessionId, pending.claimedAt ?? null) === "stale") {
    logger.warn(
      { sessionId, tool: call.name, toolUseId: pending.toolUseId },
      "stale claim: a previous attempt died holding it, outcome unknown",
    );
    recordToolOutcome(sessionId, pending.toolUseId, "system");
    return unpause(
      sessionId,
      pending.toolUseId,
      "approved",
      resolvedBy,
      pending.completedResults,
      {
        tool_use_id: pending.toolUseId,
        content:
          "This call was already attempted and the outcome is unknown - it may have run. Do not re-execute it automatically. Tell the operator what was attempted and ask whether to retry.",
        is_error: true,
      },
      { toolName: call.name, input: call.input },
      "system",
    );
  }

  if (pending.kind === "clarification") {
    logger.info({ sessionId, resolvedBy }, "clarification answered");
    return unpause(
      sessionId,
      pending.toolUseId,
      "answered",
      resolvedBy,
      pending.completedResults,
      { tool_use_id: pending.toolUseId, content: answer },
      { toolName: call.name, input: call.input },
    );
  }

  // kind === "approval"
  if (decision === "approve") {
    // executeApprovedTool never throws - every fault becomes an is_error result -
    // so the approve path always reaches unpause() and the run always resumes.
    const { result, outcome } = await executeApprovedTool(pending, call);
    logger.info({ sessionId, tool: call.name, resolvedBy }, "approved");
    return unpause(
      sessionId,
      pending.toolUseId,
      "approved",
      resolvedBy,
      pending.completedResults,
      result,
      { toolName: call.name, input: call.input },
      outcome,
    );
  }

  // Only what is true: the operator said no. Why is in their comment or it is
  // unknown, and inferring a motive from the alert's severity hands the agent
  // one nobody gave. A rejection redirects the work, so this asks what next.
  const gatedResult: ToolResult = {
    tool_use_id: pending.toolUseId,
    content: `The operator rejected this call, so it did not run and nothing on the system changed. ${
      answer
        ? `They said: "${answer}". Take that into account`
        : "They gave no reason. Take the rejection itself as the signal"
    }, then continue the investigation with a different approach. Do not call this tool again with the same arguments.`,
    is_error: true,
  };
  // The one outcome a human authors. The transcript carries the refusal we sent
  // the model, which reads as a failure; only this says a person chose it.
  recordToolOutcome(sessionId, pending.toolUseId, "rejected");
  logger.info({ sessionId, tool: call.name, resolvedBy }, "rejected");
  return unpause(
    sessionId,
    pending.toolUseId,
    "rejected",
    resolvedBy,
    pending.completedResults,
    gatedResult,
    { toolName: call.name, input: call.input },
    "rejected",
  );
}
