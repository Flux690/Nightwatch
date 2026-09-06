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
  ApprovalStatus,
  MessagePart,
  RespondRequest,
  TranscriptRow,
} from "@nightwarden/shared";

// The three a person can settle a gate with. `pending` and `continued` are the
// other two an approval can be, and neither reaches this turn.
type Settled = Extract<ApprovalStatus, "approved" | "rejected" | "answered">;

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
  toolCallId: string,
): Promise<{ name: string; input: Record<string, unknown> }> {
  const call = await findToolCall(sessionId, toolCallId);
  if (!call) {
    throw new HumanInputError(
      409,
      `No tool call ${toolCallId} in session ${sessionId}`,
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

// The whole turn's results as one row, since the wire needs one message. Written
// here because the result of a command that already ran must survive a crash.
async function answeredTurn(
  sessionId: string,
  results: ToolResult[],
  decision: MessagePart,
): Promise<TranscriptRow> {
  const parts: MessagePart[] = [
    ...results.map((r): MessagePart => ({
      type: "tool_result",
      toolCallId: r.toolCallId,
      output: r.content,
      ...(r.isError === true && { isError: true }),
    })),
    decision,
  ];
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
  toolCallId: string,
  status: Settled,
  completedResults: ToolResult[],
  answer: ToolResult,
  card: { toolName: string; input: Record<string, unknown> },
  said: string,
): Promise<HumanInputActionResult> {
  const resolvedAt = new Date().toISOString();
  // A part of its own rather than a field on the result: being asked a question
  // and permitting a write are different acts, and only this records either.
  const decision: MessagePart =
    status === "answered"
      ? { type: "elicitation_answer", toolCallId, text: said }
      : {
          type: "tool_approval",
          toolCallId,
          approved: status === "approved",
          ...(said !== "" && { reason: said }),
        };

  // One transaction with the gate clear, so the seed the resumed run builds
  // already holds this answer and nothing has to hand it over.
  const answered = await answeredTurn(
    sessionId,
    [...completedResults, answer],
    decision,
  );
  if (!(await appendRowsAndResolve(sessionId, [answered]))) {
    throw new HumanInputError(
      409,
      "Human input already resolved by another request",
    );
  }

  publishTranscriptItem({
    sessionId,
    item: toolCallCard({
      toolCallId,
      toolName: card.toolName,
      input: card.input,
      state: {
        phase: "resolved",
        decision: status,
        // An approved tool ran and an answer is what the person said; a
        // rejection ran nothing, and already reads as Declined.
        ...(status !== "rejected" && { result: answer.content }),
        ...(answer.isError === true && { isError: true }),
      },
    }),
  });

  publishInterruptResolved({
    sessionId,
    toolCallId,
    status,
    resolvedAt,
  });

  await dispatcher.dispatch({ sessionId, seed: await buildSeed(sessionId) });

  return { sessionId, toolCallId, status, resolvedAt };
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
        toolCallId: pending.toolCallId,
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
        toolCallId: pending.toolCallId,
        status: "rejected",
        resolvedAt,
      };
    }
    publishInterruptResolved({
      sessionId,
      toolCallId: pending.toolCallId,
      status: "continued",
      resolvedAt,
    });
    logger.info({ sessionId }, "continue request resumed by user");
    await dispatcher.dispatch({ sessionId, seed: await buildSeed(sessionId) });
    return {
      sessionId,
      toolCallId: pending.toolCallId,
      status: "continued",
      resolvedAt,
    };
  }

  // Everything past the continue branch gates on a real tool call.
  const call = await requireGatedCall(sessionId, pending.toolCallId);

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
      { sessionId, tool: call.name, toolCallId: pending.toolCallId },
      "stale claim: a previous attempt died holding it, toolOutcome unknown",
    );
    return await unpause(
      sessionId,
      pending.toolCallId,
      "approved",
      pending.completedResults,
      {
        toolCallId: pending.toolCallId,
        content:
          "This call was already attempted and it may have run. Do not re-execute it automatically. Tell the user what was attempted and ask whether to retry.",
        isError: true,
      },
      { toolName: call.name, input: call.input },
      "",
    );
  }

  if (pending.kind === "clarification") {
    logger.info({ sessionId }, "clarification answered");
    return await unpause(
      sessionId,
      pending.toolCallId,
      "answered",
      pending.completedResults,
      { toolCallId: pending.toolCallId, content: answer },
      { toolName: call.name, input: call.input },
      "",
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
      pending.toolCallId,
      "approved",
      pending.completedResults,
      result,
      { toolName: call.name, input: call.input },
      "",
    );
  }

  // Only what is true: the user said no. Inferring a motive from severity
  // would hand the agent one nobody gave, so this asks what to do next.
  const gatedResult: ToolResult = {
    toolCallId: pending.toolCallId,
    content: `The user rejected this call, so it did not run and nothing on the system changed. ${
      answer
        ? `They said: "${answer}". Take that into account`
        : "They gave no reason. Take the rejection itself as the signal"
    }, then continue the investigation with a different approach. Do not call this tool again with the same arguments.`,
    // The tool never ran. That a person chose this is their own fact, which
    // the approval part beside this result carries.
    isError: true,
  };
  logger.info({ sessionId, tool: call.name }, "rejected");
  return await unpause(
    sessionId,
    pending.toolCallId,
    "rejected",
    pending.completedResults,
    gatedResult,
    { toolName: call.name, input: call.input },
    answer,
  );
}
