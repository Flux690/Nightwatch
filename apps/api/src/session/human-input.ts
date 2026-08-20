import {
  claimPendingHumanInput,
  deletePendingHumanInput,
  getPendingHumanInputBySessionId,
} from "../db/interrupts.js";
import { findToolCall } from "../db/sessions.js";
import { loadConfig } from "../config/store.js";
import { dispatcher } from "../dispatcher.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { publishInterruptResolved, publishTranscriptItem } from "./stream.js";
import { toolCallCard } from "./transcript.js";
import { buildSeed } from "./seed.js";
import { executeApprovedTool } from "./approval-executor.js";
import type { ApprovalResponse, RespondRequest } from "@nightwarden/shared";

export class HumanInputError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface HumanInputActionResult extends ApprovalResponse {
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

/* A compare-and-swap, so a failure means someone else holds it - a live request,
   or a process that died holding it. Age tells them apart. "stale" is why the
   claim is never cleared at boot: the write may already have run. */
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
  completedResults: ToolResult[],
  gatedResult: ToolResult,
  card: { toolName: string; input: Record<string, unknown> },
): HumanInputActionResult {
  ensureDeleted(sessionId);

  const resolvedAt = new Date().toISOString();
  // Read off the result rather than passed beside it: how a call went belongs
  // to the call, and two ways to say it is one way to say two things.
  const { outcome } = gatedResult;

  publishTranscriptItem({
    sessionId,
    item: toolCallCard({
      toolUseId,
      toolName: card.toolName,
      input: card.input,
      state: {
        phase: "resolved",
        decision: status,
        // An approved tool ran and an answer is what the person said; a
        // rejection ran nothing, and its outcome already reads as Declined.
        ...(status !== "rejected" && { result: gatedResult.content }),
        ...(outcome !== undefined && { outcome }),
      },
    }),
  });

  publishInterruptResolved({
    sessionId,
    toolUseId,
    status,
    resolvedAt,
  });

  dispatcher.dispatch({
    sessionId,
    seed: buildSeed(sessionId),
    resumeToolResults: [...completedResults, gatedResult],
  });

  return { sessionId, toolUseId, status, resolvedAt };
}

export async function respondToPendingHumanInput(
  sessionId: string,
  request: RespondRequest,
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
        resolvedAt,
      });
      logger.info({ sessionId }, "continue request ended by user");
      dispatcher.dispatch({
        sessionId,
        seed: buildSeed(sessionId),
        standDown: true,
      });
      return {
        sessionId,
        toolUseId: pending.toolUseId,
        status: "rejected",
        resolvedAt,
      };
    }
    publishInterruptResolved({
      sessionId,
      toolUseId: pending.toolUseId,
      status: "continued",
      resolvedAt,
    });
    logger.info({ sessionId }, "continue request resumed by user");
    dispatcher.dispatch({ sessionId, seed: buildSeed(sessionId) });
    return {
      sessionId,
      toolUseId: pending.toolUseId,
      status: "continued",
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
    return unpause(
      sessionId,
      pending.toolUseId,
      "approved",
      pending.completedResults,
      {
        tool_use_id: pending.toolUseId,
        content:
          "This call was already attempted and the outcome is unknown - it may have run. Do not re-execute it automatically. Tell the user what was attempted and ask whether to retry.",
        is_error: true,
        outcome: "system",
      },
      { toolName: call.name, input: call.input },
    );
  }

  if (pending.kind === "clarification") {
    logger.info({ sessionId }, "clarification answered");
    return unpause(
      sessionId,
      pending.toolUseId,
      "answered",
      pending.completedResults,
      { tool_use_id: pending.toolUseId, content: answer },
      { toolName: call.name, input: call.input },
    );
  }

  // kind === "approval"
  if (decision === "approve") {
    // executeApprovedTool never throws - every fault becomes an is_error result -
    // so the approve path always reaches unpause() and the run always resumes.
    const result = await executeApprovedTool(pending, call);
    logger.info({ sessionId, tool: call.name }, "approved");
    return unpause(
      sessionId,
      pending.toolUseId,
      "approved",
      pending.completedResults,
      result,
      { toolName: call.name, input: call.input },
    );
  }

  // Only what is true: the user said no. Why is in their comment or it is
  // unknown, and inferring a motive from the alert's severity hands the agent
  // one nobody gave. A rejection redirects the work, so this asks what next.
  const gatedResult: ToolResult = {
    tool_use_id: pending.toolUseId,
    content: `The user rejected this call, so it did not run and nothing on the system changed. ${
      answer
        ? `They said: "${answer}". Take that into account`
        : "They gave no reason. Take the rejection itself as the signal"
    }, then continue the investigation with a different approach. Do not call this tool again with the same arguments.`,
    is_error: true,
    // The one outcome a human authors. The output carries the refusal we sent
    // the model, which reads as a failure; only this says a person chose it.
    outcome: "rejected",
  };
  logger.info({ sessionId, tool: call.name }, "rejected");
  return unpause(
    sessionId,
    pending.toolUseId,
    "rejected",
    pending.completedResults,
    gatedResult,
    { toolName: call.name, input: call.input },
  );
}
