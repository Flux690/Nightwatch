import type {
  ApprovalStatus,
  ContinueCardItem,
  HumanDecision,
  TranscriptRow,
  ToolCallState,
  ToolGate,
  ToolOutcome,
  TranscriptItem,
} from "@nightwarden/shared";
import {
  getPendingHumanInputBySessionId,
  hasPendingHumanInput,
} from "../db/interrupts.js";
import { getReport } from "../db/reports.js";
import { getSession, getTranscriptRows, isRunning } from "../db/sessions.js";

// The tool input's target key. A write addresses a service by it, and a tool
// that names none is not addressing one.
export function targetKeyFromInput(
  input: Record<string, unknown>,
): string | null {
  const target = input["target"];
  return typeof target === "string" ? target : null;
}

/* The only place a tool call becomes an item. Both the transcript fetch and the
   live stream call it, which is what keeps a streamed card and a reloaded one
   byte-identical instead of merely similar.

   It chooses nothing. A call is one kind and its state says where in its life it
   is, so there is no label here that could disagree with the state beside it -
   which is what let a settled approval keep claiming to be one. */
export function toolCallCard(call: {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  state: ToolCallState;
  // How many times this same write already ran in this investigation. The
  // caller counts it, because only a walk of the transcript can.
  priorRuns?: number;
}): TranscriptItem {
  const { toolUseId, toolName, input, state } = call;
  const priorRuns = call.priorRuns ?? 0;
  return {
    kind: "tool_call",
    toolUseId,
    toolName,
    input,
    ...(priorRuns > 0 && { priorRuns }),
    state,
  };
}

// The time-budget prompt, which no model asked for and which answers to nobody's
// tool call. Its own function because its states are its own.
export function continueCard(
  toolUseId: string,
  state: ContinueCardItem["state"],
): ContinueCardItem {
  return { kind: "continue_card", toolUseId, state };
}

/* Repeating a fix is rarely fixing it, and 3am is when that is easiest to miss.
   It reports, it never refuses - a person who restarts a fifth time has made a
   decision, not a mistake. */
function priorRunsOf(
  toolName: string,
  input: Record<string, unknown>,
  approved: Array<{ toolName: string; target: string | null }>,
): number {
  const target = targetKeyFromInput(input);
  if (target === null) return 0;
  return approved.filter((a) => a.toolName === toolName && a.target === target)
    .length;
}

/* Read back from the report column, since the write-up is not a turn: a finished
   investigation with claims but no report is one where the report turn did not
   land. A session parked on a human has not reached that turn, so it gets none. */
function reportCard(sessionId: string): TranscriptItem | null {
  const session = getSession(sessionId);
  if (session === undefined || !session.investigation) return null;
  if (getReport(sessionId)?.submitted != null) {
    return { kind: "report_card", id: "report", state: { phase: "ready" } };
  }
  if (isRunning(sessionId) || hasPendingHumanInput(sessionId)) return null;
  const hypotheses = getReport(sessionId)?.hypotheses ?? [];
  return hypotheses.length === 0
    ? null
    : { kind: "report_card", id: "report", state: { phase: "failed" } };
}

// A tool call's state, in precedence order: what the session is suspended on
// beats what a human already decided, which beats the tool merely having run.
function toolCallState(
  result: string | undefined,
  gate: ToolGate | null,
  decided: ApprovalStatus | null,
  outcome: ToolOutcome | undefined,
): ToolCallState {
  if (gate !== null) return { phase: "awaiting_human", gate };
  const classified = outcome === undefined ? {} : { outcome };
  /* Every path a person is on ends here, including an answered question: the
     decision was recorded when they were asked, so nothing needs to work out
     from a tool's name whether the words in the result are theirs. */
  if (decided !== null)
    return {
      phase: "resolved",
      decision: decided,
      ...(result !== undefined && { result }),
      ...classified,
    };
  if (result === undefined) return { phase: "running" };
  return { phase: "complete", result, ...classified };
}

// The one place a transcript becomes something to draw. Everything the console
// needs about a tool call - its result, whether it waits on a human - is decided
// here, so the browser never reconciles sources against each other.
export function buildTranscript(sessionId: string): TranscriptItem[] {
  const messages: TranscriptRow[] = getTranscriptRows(sessionId);
  // Which call is waiting, and of what kind. What that call was comes from the
  // transcript rows below, which hold it already.
  const pending = getPendingHumanInputBySessionId(sessionId) ?? null;

  /* What the user decided, read back from what was recorded when they were
     asked. Not reconstructed from the tool's name: that cannot tell a call a
     person released from one the harness refused without ever drawing a card. */
  const decisionFor = (
    toolUseId: string,
    settled: boolean,
  ): ApprovalStatus | null =>
    settled ? (decisions.get(toolUseId) ?? null) : null;

  // One pass for all three: a result, how it went, and what a person said all
  // arrive on the same part.
  const results = new Map<string, string>();
  const outcomes = new Map<string, ToolOutcome>();
  const decisions = new Map<string, HumanDecision>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool_result") {
        results.set(part.toolCallId, part.output);
        if (part.outcome !== undefined) {
          outcomes.set(part.toolCallId, part.outcome);
        }
        if (part.humanDecision !== undefined) {
          decisions.set(part.toolCallId, part.humanDecision);
        }
      }
    }
  }

  /* The ones that opened the session are excluded: the report's alert band sits
     above them. Read from the row rather than compared clocks - which alerts
     opened a session is known when they are written. */
  const arrivals = (getSession(sessionId)?.alerts ?? []).filter(
    (entry) => entry.injected,
  );
  let nextArrival = 0;

  // Writes the user already released, in the order they ran, so the approval
  // card can say this is the third restart of the same service.
  const approved: Array<{ toolName: string; target: string | null }> = [];

  const items: TranscriptItem[] = [];
  for (const msg of messages) {
    // Placed where it interrupted: everything the agent did before this message
    // happened before the alert landed, and everything after it, after.
    while (
      nextArrival < arrivals.length &&
      arrivals[nextArrival]!.arrivedAt <= msg.timestamp
    ) {
      const entry = arrivals[nextArrival]!;
      items.push({
        kind: "alert_arrived",
        id: `alert-${entry.alert.sourceAlertId}-${entry.arrivedAt}`,
        alertType: entry.alert.alertType,
        severity: entry.alert.severity,
      });
      nextArrival++;
    }

    // The harness talking to the model, not to the user. Stored so a resume
    // replays faithfully; never drawn, so the transcript reads as one
    // conversation between two parties.
    if (msg.kind === "nightwarden") continue;

    if (msg.kind === "error") {
      if (msg.content) {
        items.push({
          kind: "error_text",
          id: `error-${msg.seq}`,
          text: msg.content,
        });
      }
      continue;
    }

    if (msg.parts.length === 0) {
      if (msg.content) {
        items.push(
          msg.kind === "user"
            ? { kind: "user_turn", id: `user-${msg.seq}`, text: msg.content }
            : {
                kind: "agent_text",
                id: `${msg.kind}-${msg.seq}`,
                text: msg.content,
                turn: msg.seq,
              },
        );
      }
      continue;
    }

    let idx = 0;
    for (const part of msg.parts) {
      const id = `${msg.kind}-${msg.seq}-${idx++}`;
      if (part.type === "text") {
        if (!part.text) continue;
        items.push(
          msg.kind === "user"
            ? { kind: "user_turn", id, text: part.text }
            : { kind: "agent_text", id, text: part.text, turn: msg.seq },
        );
      } else if (part.type === "compaction") {
        items.push({ kind: "compaction", id });
      } else if (part.type === "reasoning") {
        if (part.text.trim()) {
          items.push({
            kind: "thinking",
            id,
            text: part.text,
            streaming: false,
            turn: msg.seq,
          });
        }
      } else if (part.type === "tool_call") {
        const awaiting = pending?.toolUseId === part.id ? pending : null;
        // "continue" cannot reach here: its id is synthetic and answers to no
        // turn, so it never matches a tool call part.
        const gate =
          awaiting !== null && awaiting.kind !== "continue"
            ? awaiting.kind
            : null;
        const decided = decisionFor(
          part.id,
          results.has(part.id) && awaiting === null,
        );
        items.push(
          toolCallCard({
            toolUseId: part.id,
            toolName: part.name,
            input: part.input,
            state: toolCallState(
              results.get(part.id),
              gate,
              decided,
              outcomes.get(part.id),
            ),
            priorRuns: priorRunsOf(part.name, part.input, approved),
          }),
        );
        // Counted in transcript order, so a card reports what ran before it and
        // never counts itself.
        if (decided === "approved") {
          approved.push({
            toolName: part.name,
            target: targetKeyFromInput(part.input),
          });
        }
      }
    }
  }

  // An alert that landed after the last persisted turn still belongs on the end
  // rather than nowhere.
  for (const entry of arrivals.slice(nextArrival)) {
    items.push({
      kind: "alert_arrived",
      id: `alert-${entry.alert.sourceAlertId}-${entry.arrivedAt}`,
      alertType: entry.alert.alertType,
      severity: entry.alert.severity,
    });
  }

  // No model asked for it, so the walk above has no tool call to project. The
  // interrupt row is the only record, or a reloaded session offers no way out.
  if (pending?.kind === "continue") {
    items.push(continueCard(pending.toolUseId, { phase: "awaiting_human" }));
  }

  // Last, because writing up is the last thing a run does.
  const report = reportCard(sessionId);
  if (report !== null) items.push(report);

  return items;
}
