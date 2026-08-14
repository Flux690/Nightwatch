import type { MessagePart, TranscriptRow } from "@nightwarden/shared";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import { isToolFailure } from "../agent/tools/types.js";
import { loadConfig } from "../config/store.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import {
  appendErrorMessage,
  appendTranscriptRows,
  getNextSeq,
  getSession,
  getTranscriptRows,
  markDone,
  runningSessionIds,
  suspendedSessionIds,
} from "../db/sessions.js";
import { dispatcher } from "../dispatcher.js";
import { logger } from "../logger.js";
import { buildSeed } from "./seed.js";

/* How recent a dead run has to be to be worth continuing. Deliberately a
   constant: a user has no basis to reason about it, and it is not
   `checkInAfterMs`, which answers how long a run works before checking in. */
const RESUME_WINDOW_MS = 15 * 60_000;

const INTERRUPTED =
  "This investigation was interrupted: NightWarden stopped while it was running.";

const ABANDONED =
  "This investigation was interrupted: NightWarden stopped just after the approved call ran, so its result was lost. Whether the call took effect is unknown - check the target before approving it again.";

interface PendingCall {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

// Calls the transcript never answered, which is what a crash between writing the
// assistant turn and running its tools leaves behind.
function unansweredCalls(rows: TranscriptRow[]): PendingCall[] {
  const answered = new Set<string>();
  const calls: PendingCall[] = [];
  for (const row of rows) {
    for (const part of row.parts) {
      if (part.type === "tool_call") {
        calls.push({ toolUseId: part.id, name: part.name, input: part.input });
      } else if (part.type === "tool_result") {
        answered.add(part.toolCallId);
      }
    }
  }
  return calls.filter((call) => !answered.has(call.toolUseId));
}

/* Whether running it a second time is safe. A read changed nothing, so reading
   again is reading; a write is only replayable where the tool states why. An
   elicitation never executes at all, so it is neither. */
function replayable(name: string): boolean {
  const tool = findTool(name);
  if (tool === undefined) return false;
  return tool.effect === "read" || tool.idempotent === true;
}

/* Answers every call the crash left open, in one turn, the way a provider would.
   Returns false when any of them cannot be replayed, which leaves the exchange
   unanswered so the seed unwinds past it instead. */
async function answerPendingCalls(
  sessionId: string,
  calls: PendingCall[],
): Promise<boolean> {
  if (!calls.every((call) => replayable(call.name))) return false;

  const parts: MessagePart[] = [];
  const texts: string[] = [];
  for (const call of calls) {
    const tool = findTool(call.name);
    if (tool === undefined) return false;
    const { content, outcome } = await executeTool(tool, call.input, {
      sessionId,
      toolUseId: call.toolUseId,
      toolCallCeilingMs: loadConfig().toolCallCeilingMs,
    });
    parts.push({
      type: "tool_result",
      toolCallId: call.toolUseId,
      output: content,
      ...(isToolFailure(outcome) && { isError: true }),
      ...(outcome !== undefined && { outcome }),
    });
    texts.push(content);
  }

  appendTranscriptRows([
    {
      sessionId,
      seq: getNextSeq(sessionId),
      kind: "user",
      content: texts.join("\n"),
      parts,
      timestamp: new Date().toISOString(),
    },
  ]);
  return true;
}

// Recent enough that the evidence it gathered still describes the incident, and
// still holding a condition nobody has seen recover.
function worthResuming(sessionId: string): boolean {
  const session = getSession(sessionId);
  if (session === undefined) return false;
  if (!session.alerts.some((entry) => entry.clearedAt === null)) return false;
  const rows = getTranscriptRows(sessionId);
  const last = rows[rows.length - 1]?.timestamp ?? session.createdAt;
  return Date.now() - new Date(last).getTime() <= RESUME_WINDOW_MS;
}

/* 'running' was killed mid-turn and may be repairable. 'suspended' with no
   interrupt row died between approving a call and claiming the resume: the write
   already ran and its result is gone, and it holds a seat until we say so. */
function strandedSessions(): Array<{ sessionId: string; killed: boolean }> {
  const killed = runningSessionIds().map((sessionId) => ({
    sessionId,
    killed: true,
  }));
  const abandoned = suspendedSessionIds()
    .filter((sessionId) => !hasPendingHumanInput(sessionId))
    .map((sessionId) => ({ sessionId, killed: false }));
  return [...killed, ...abandoned];
}

/* Runs before the server listens, so nothing can dispatch into a session this is
   still deciding about. */
export async function recoverDeadRuns(): Promise<{
  failed: number;
  resumed: number;
}> {
  const result = { failed: 0, resumed: 0 };
  for (const { sessionId, killed } of strandedSessions()) {
    // markDone rather than releaseRun: an abandoned suspension is not running,
    // which is exactly why releaseRun would decline to touch it.
    markDone(sessionId);
    try {
      if (!killed) {
        appendErrorMessage(sessionId, ABANDONED);
        result.failed++;
        continue;
      }
      const pending = unansweredCalls(getTranscriptRows(sessionId));
      if (pending.length > 0) {
        await answerPendingCalls(sessionId, pending);
      }
      /* The note is written only when nobody is picking this up. Writing it
         before a resume would unwind the seed past the exchange just repaired,
         since an error row is what tells buildSeed an exchange died. */
      if (worthResuming(sessionId)) {
        dispatcher.dispatch({ sessionId, seed: buildSeed(sessionId) });
        result.resumed++;
        continue;
      }
      appendErrorMessage(sessionId, INTERRUPTED);
      result.failed++;
    } catch (err) {
      // One session's recovery must never stop the boot: the rest of the fleet
      // is waiting on this process to start listening.
      logger.warn(
        { err, sessionId },
        "could not recover a run interrupted by a restart",
      );
    }
  }
  return result;
}
