import {
  claimPendingHumanInput,
  deletePendingHumanInput,
  getPendingHumanInputBySessionId,
} from "./gate-store.js";
import {
  appendRowsAndResolve,
  findToolCall,
  getNextSeq,
} from "./transcript-store.js";
import { stripHarnessMarker } from "../agent/harness-marker.js";
import { loadConfig } from "../config/store.js";
import { dispatcher } from "../dispatcher.js";
import type { ToolResult } from "../llm/types.js";
import { logger } from "../logger.js";
import { publishInterruptResolved, publishTranscriptItem } from "./stream.js";
import { toolCallCard } from "./transcript.js";
import { buildSeed } from "./seed.js";
import { executeApprovedTool } from "./approval-executor.js";
import { messagePartsToText } from "@nightwarden/shared";
import type {
  ApprovalResponse,
  HumanDecision,
  MessagePart,
  RespondRequest,
  TranscriptRow,
} from "@nightwarden/shared";

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

async function requirePendingHumanInput(sessionId: string) {
  const pending = await getPendingHumanInputBySessionId(sessionId);
  if (!pending) {
    throw new HumanInputError(
      409,
      `No pending human input for session: ${sessionId}`,
    );
  }
  return pending;
}

// Both are written in one transaction, so a miss here is a contradiction
// rather than a case to carry forward with an empty tool name.
async function requireGatedCall(
  sessionId: string,
  toolUseId: string,
): Promise<{ name: string; input: Record<string, unknown> }> {
  const call = await findToolCall(sessionId, toolUseId);
  if (!call) {
    throw new HumanInputError(
      409,
      `No tool call ${toolUseId} in session ${sessionId}`,
    );
  }
  return call;
}

// A compare-and-swap, so a failure means someone else holds it and age tells
// a live request from a dead one. Never cleared at boot: the write may have run.
async function claim(
  sessionId: string,
  claimedAt: string | null,
): Promise<"held" | "stale"> {
  if (await claimPendingHumanInput(sessionId)) return "held";
  const heldForMs =
    claimedAt === null ? 0 : Date.now() - new Date(claimedAt).getTime();
  if (heldForMs <= (await loadConfig()).toolCallCeilingMs) {
    throw new HumanInputError(
      409,
      "Human input already claimed by another request",
    );
  }
  return "stale";
}

async function ensureDeleted(sessionId: string): Promise<void> {
  if (!(await deletePendingHumanInput(sessionId))) {
    throw new HumanInputError(
      409,
      "Human input already resolved by another request",
    );
  }
}

// The whole turn's results as one row, since the wire needs one message for it.
// Written rather than left to the resumed run: the result of a command that has
// already run is the one thing a crash must not lose.
async function answeredTurn(
  sessionId: string,
  results: ToolResult[],
): Promise<TranscriptRow> {
  const parts: MessagePart[] = results.map((r) => ({
    type: "tool_result",
    toolCallId: r.tool_use_id,
    output: r.content,
    ...(r.is_error === true && { isError: true }),
    ...(r.toolOutcome !== undefined && { toolOutcome: r.toolOutcome }),
    ...(r.humanDecision !== undefined && { humanDecision: r.humanDecision }),
  }));
  return {
    sessionId,
    seq: await getNextSeq(sessionId),
    kind: "user",
    content: messagePartsToText(parts),
    parts,
    timestamp: new Date().toISOString(),
  };
}

async function unpause(
  sessionId: string,
  toolUseId: string,
  status: HumanDecision,
  completedResults: ToolResult[],
  answer: ToolResult,
  card: { toolName: string; input: Record<string, unknown> },
): Promise<HumanInputActionResult> {
  const resolvedAt = new Date().toISOString();
  // Stamped here rather than at each call site: every path through this
  // function had a human at the end of it, and no other path did.
  const gatedResult: ToolResult = { ...answer, humanDecision: status };
  // Read off the result rather than passed beside it: how a call went belongs
  // to the call, and two ways to say it is one way to say two things.
  const { toolOutcome } = gatedResult;

  // One transaction with the gate clear, so the seed the resumed run builds
  // already holds this answer and nothing has to hand it over.
  const answered = await answeredTurn(sessionId, [
    ...completedResults,
    gatedResult,
  ]);
  if (!(await appendRowsAndResolve(sessionId, [answered]))) {
    throw new HumanInputError(
      409,
      "Human input already resolved by another request",
    );
  }

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
        ...(toolOutcome !== undefined && { toolOutcome }),
      },
    }),
  });

  publishInterruptResolved({
    sessionId,
    toolUseId,
    status,
    resolvedAt,
  });

  await dispatcher.dispatch({ sessionId, seed: await buildSeed(sessionId) });

  return { sessionId, toolUseId, status, resolvedAt };
}

export async function respondToPendingHumanInput(
  sessionId: string,
  request: RespondRequest,
): Promise<HumanInputActionResult> {
  const pending = await requirePendingHumanInput(sessionId);
  const { decision, text } = request;

  if (pending.kind === "continue") {
    // No async work between resolve and dispatch, so ensureDeleted alone is the
    // concurrency gate; claimOrThrow is skipped since nothing here executes async.
    await ensureDeleted(sessionId);
    const resolvedAt = new Date().toISOString();
    if (decision === "reject") {
      publishInterruptResolved({
        sessionId,
        toolUseId: pending.toolUseId,
        status: "rejected",
        resolvedAt,
      });
      logger.info({ sessionId }, "continue request ended by user");
      await dispatcher.dispatch({
        sessionId,
        seed: await buildSeed(sessionId),
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
    await dispatcher.dispatch({ sessionId, seed: await buildSeed(sessionId) });
    return {
      sessionId,
      toolUseId: pending.toolUseId,
      status: "continued",
      resolvedAt,
    };
  }

  // Everything past the continue branch gates on a real tool call.
  const call = await requireGatedCall(sessionId, pending.toolUseId);

  // Before the claim, so a malformed request is refused without taking the lock
  // and wedging the interrupt for the well-formed retry behind it.
  const answer = stripHarnessMarker(text?.trim() ?? "");
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

  if ((await claim(sessionId, pending.claimedAt ?? null)) === "stale") {
    logger.warn(
      { sessionId, tool: call.name, toolUseId: pending.toolUseId },
      "stale claim: a previous attempt died holding it, toolOutcome unknown",
    );
    return await unpause(
      sessionId,
      pending.toolUseId,
      "approved",
      pending.completedResults,
      {
        tool_use_id: pending.toolUseId,
        content:
          "This call was already attempted and the toolOutcome is unknown - it may have run. Do not re-execute it automatically. Tell the user what was attempted and ask whether to retry.",
        is_error: true,
        toolOutcome: "system",
      },
      { toolName: call.name, input: call.input },
    );
  }

  if (pending.kind === "clarification") {
    logger.info({ sessionId }, "clarification answered");
    return await unpause(
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
    return await unpause(
      sessionId,
      pending.toolUseId,
      "approved",
      pending.completedResults,
      result,
      { toolName: call.name, input: call.input },
    );
  }

  // Only what is true: the user said no. Inferring a motive from severity
  // would hand the agent one nobody gave, so this asks what to do next.
  const gatedResult: ToolResult = {
    tool_use_id: pending.toolUseId,
    content: `The user rejected this call, so it did not run and nothing on the system changed. ${
      answer
        ? `They said: "${answer}". Take that into account`
        : "They gave no reason. Take the rejection itself as the signal"
    }, then continue the investigation with a different approach. Do not call this tool again with the same arguments.`,
    // No outcome: the tool never ran. That a person chose this is a fact about
    // them, which humanDecision carries.
    is_error: true,
  };
  logger.info({ sessionId, tool: call.name }, "rejected");
  return await unpause(
    sessionId,
    pending.toolUseId,
    "rejected",
    pending.completedResults,
    gatedResult,
    { toolName: call.name, input: call.input },
  );
}
