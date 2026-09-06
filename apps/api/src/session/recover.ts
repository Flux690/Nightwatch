import type { MessagePart, TranscriptRow } from "@nightwarden/shared";
import { evidenceIdsIn } from "../agent/evidence-id.js";
import { executeTool, findTool } from "../agent/tools/toolset.js";
import { loadConfig } from "../config/store.js";
import { hasPendingHumanInput } from "./gate-store.js";
import {
  abandonedSessionIds,
  markDone,
  runningSessionIds,
} from "./status-store.js";
import { getSession } from "./store.js";
import {
  appendErrorMessage,
  appendTranscriptRows,
  getNextSeq,
  getTranscriptRows,
} from "./transcript-store.js";
import { dispatcher } from "../dispatcher.js";
import { logger } from "../logger.js";
import { buildSeed } from "./seed.js";

// A constant on purpose: a user has no basis to reason about it, and it is
// not checkInAfterMs, which answers how long a run works before checking in.
const RESUME_WINDOW_MS = 15 * 60_000;

const INTERRUPTED =
  "This investigation was interrupted: NightWarden stopped while it was running.";

const ABANDONED =
  "This investigation was interrupted: NightWarden stopped just after the approved call ran, so its result was lost. Whether the call took effect is unknown - check the target before approving it again.";

interface PendingCall {
  toolCallId: string;
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
        calls.push({
          toolCallId: part.toolCallId,
          name: part.name,
          input: part.input,
        });
      } else if (part.type === "tool_result") {
        answered.add(part.toolCallId);
      }
    }
  }
  return calls.filter((call) => !answered.has(call.toolCallId));
}

// A read changed nothing, so reading again is reading. A write is replayable
// only where the tool states why, and an elicitation never executes at all.
function replayable(name: string): boolean {
  const tool = findTool(name);
  if (tool === undefined) return false;
  return tool.effect === "read" || tool.idempotent === true;
}

// False when any call cannot be replayed, which leaves the exchange unanswered
// so the seed unwinds past it instead.
async function answerPendingCalls(
  sessionId: string,
  calls: PendingCall[],
): Promise<boolean> {
  if (!calls.every((call) => replayable(call.name))) return false;

  // A replay answers calls the transcript already holds, so it adds no numbers.
  const evidenceIds = evidenceIdsIn(await getTranscriptRows(sessionId));
  const parts: MessagePart[] = [];
  const texts: string[] = [];
  for (const call of calls) {
    const tool = findTool(call.name);
    if (tool === undefined) return false;
    const evidenceId = evidenceIds.get(call.toolCallId);
    const { content, isError } = await executeTool(tool, call.input, {
      sessionId,
      toolCallId: call.toolCallId,
      toolCallCeilingMs: (await loadConfig()).toolCallCeilingMs,
      ...(evidenceId !== undefined && { evidenceId }),
    });
    parts.push({
      type: "tool_result",
      toolCallId: call.toolCallId,
      output: content,
      ...(isError === true && { isError: true }),
    });
    texts.push(content);
  }

  await appendTranscriptRows([
    {
      sessionId,
      seq: await getNextSeq(sessionId),
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
async function worthResuming(sessionId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  if (session === undefined) return false;
  if (!session.alerts.some((entry) => entry.clearedAt === null)) return false;
  const rows = await getTranscriptRows(sessionId);
  const last = rows[rows.length - 1]?.timestamp ?? session.createdAt;
  return Date.now() - new Date(last).getTime() <= RESUME_WINDOW_MS;
}

// 'action_required' with no gate row died between approving a call and claiming
// the resume: the write already ran, its result is gone, and it holds a seat.
async function strandedSessions(): Promise<
  Array<{ sessionId: string; killed: boolean }>
> {
  const killed = (await runningSessionIds()).map((sessionId: string) => ({
    sessionId,
    killed: true,
  }));
  // Sequential rather than Array.filter: an async predicate returns a promise,
  // which is always truthy, so a parked session would survive the filter.
  const abandoned: Array<{ sessionId: string; killed: boolean }> = [];
  for (const sessionId of await abandonedSessionIds()) {
    if (!(await hasPendingHumanInput(sessionId))) {
      abandoned.push({ sessionId, killed: false });
    }
  }
  return [...killed, ...abandoned];
}

/* Runs before the server listens, so nothing can dispatch into a session this is
   still deciding about. */
export async function recoverDeadRuns(): Promise<{
  failed: number;
  resumed: number;
}> {
  const result = { failed: 0, resumed: 0 };
  for (const { sessionId, killed } of await strandedSessions()) {
    // markDone rather than releaseRun: an abandoned suspension is not running,
    // which is exactly why releaseRun would decline to touch it.
    await markDone(sessionId);
    try {
      if (!killed) {
        await appendErrorMessage(sessionId, ABANDONED);
        result.failed++;
        continue;
      }
      const pending = unansweredCalls(await getTranscriptRows(sessionId));
      if (pending.length > 0) {
        await answerPendingCalls(sessionId, pending);
      }
      // Written only when nobody is picking this up: an error row is what
      // tells buildSeed an exchange died, so it would unwind the repair.
      if (await worthResuming(sessionId)) {
        await dispatcher.dispatch({
          sessionId,
          seed: await buildSeed(sessionId),
        });
        result.resumed++;
        continue;
      }
      await appendErrorMessage(sessionId, INTERRUPTED);
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
