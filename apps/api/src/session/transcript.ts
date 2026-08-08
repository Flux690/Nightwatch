import type {
  ApprovalRequest,
  ApprovalStatus,
  TranscriptRow,
  ToolCallState,
  ToolOutcome,
  TranscriptItem,
} from "@nightwarden/shared";
import { getPendingHumanInputBySessionId } from "../db/interrupts.js";
import { getSession, getTranscriptRows } from "../db/sessions.js";
import { getToolOutcomes } from "../db/tool-outcomes.js";
import { findTool } from "../agent/tools/toolset.js";

// The tool input's target key. A write addresses a service by it, and a tool
// that names none is not addressing one.
export function targetKeyFromInput(
  input: Record<string, unknown>,
): string | null {
  const target = input["target"];
  return typeof target === "string" ? target : null;
}

// Whether a call had to be approved before it could run, read from the registry
// rather than recorded: `access` is what gates it, so it is also what says a call
// was gated. Nothing can drift, and an agent-run tool can never render as one a
// human released.
export function wasGated(toolName: string): boolean {
  const tool = findTool(toolName);
  return tool !== undefined && tool.access !== "read";
}

// The only place a tool call becomes a card. Both the transcript fetch and the
// live stream call it, which is what keeps a streamed card and a reloaded one
// byte-identical instead of merely similar.
export function toolCallCard(
  call:
    | { toolUseId: string; state: ToolCallState; awaitingKind: "continue" }
    | {
        toolUseId: string;
        toolName: string;
        input: Record<string, unknown>;
        state: ToolCallState;
        awaitingKind?: "approval" | "clarification";
        // How many times this same write already ran in this investigation. The
        // caller counts it, because only a walk of the transcript can.
        priorRuns?: number;
      },
): TranscriptItem {
  const { toolUseId, state } = call;
  if (call.awaitingKind === "continue") {
    return { kind: "continue_card", toolUseId, state };
  }
  const { toolName, input, awaitingKind } = call;
  if (toolName === "AskUserQuestion") {
    const parsed = input as {
      question?: string;
      options?: Array<{ label: string; description: string }>;
      multiSelect?: boolean;
    };
    return {
      kind: "clarification_card",
      toolUseId,
      toolName,
      input,
      question: parsed.question,
      options: parsed.options,
      multiSelect: parsed.multiSelect,
      state,
    };
  }
  if (awaitingKind === "approval") {
    const risk = input["risk"];
    const priorRuns = call.priorRuns ?? 0;
    return {
      kind: "approval_card",
      toolUseId,
      toolName,
      input,
      ...(typeof risk === "string" && { risk }),
      ...(priorRuns > 0 && { priorRuns }),
      state,
    };
  }
  return { kind: "tool_card", toolUseId, toolName, input, state };
}

/* How many times this same write already ran in this investigation, counted from
   the transcript itself. Repeating a fix is rarely fixing it, and 3am is exactly
   when that pattern is easiest to miss. It reports, it never refuses - a person
   who restarts a fifth time has made a decision, not a mistake. */
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

// A tool call's state, in precedence order: what the session is suspended on
// beats what a human already decided, which beats the tool merely having run.
function toolCallState(
  toolName: string,
  result: string | undefined,
  awaiting: boolean,
  decided: ApprovalStatus | null,
  outcome: ToolOutcome | undefined,
): ToolCallState {
  if (awaiting) return { phase: "awaiting_human" };
  const classified = outcome === undefined ? {} : { outcome };
  if (decided !== null)
    return {
      phase: "resolved",
      decision: decided,
      ...(result !== undefined && { result }),
      ...classified,
    };
  if (result === undefined) return { phase: "running" };
  if (toolName === "AskUserQuestion")
    return { phase: "resolved", decision: "answered", result };
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

  const outcomes = getToolOutcomes(sessionId);

  // A decision the operator already made, reconstructed rather than stored: the
  // registry says the call needed one, and the outcome says which way it went.
  const decisionFor = (
    toolName: string,
    toolUseId: string,
    settled: boolean,
  ): ApprovalStatus | null => {
    if (!settled || !wasGated(toolName)) return null;
    return outcomes.get(toolUseId) === "rejected" ? "rejected" : "approved";
  };

  const results = new Map<string, string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool_result") {
        results.set(part.toolCallId, part.output);
      }
    }
  }

  // Alerts that arrived after the conversation started, in arrival order. The
  // ones that opened the session are excluded: they predate every message, and
  // the report's alert band sits directly above the first of them anyway.
  const firstMessageAt = messages[0]?.createdAt ?? null;
  const arrivals = (getSession(sessionId)?.alerts ?? []).filter(
    (entry) => firstMessageAt !== null && entry.arrivedAt > firstMessageAt,
  );
  let nextArrival = 0;

  // Writes the operator already released, in the order they ran, so the approval
  // card can say this is the third restart of the same service.
  const approved: Array<{ toolName: string; target: string | null }> = [];

  const items: TranscriptItem[] = [];
  for (const msg of messages) {
    // Placed where it interrupted: everything the agent did before this message
    // happened before the alert landed, and everything after it, after.
    while (
      nextArrival < arrivals.length &&
      arrivals[nextArrival]!.arrivedAt <= msg.createdAt
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

    // The harness talking to the model, not to the operator. Stored so a resume
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
        items.push({
          kind: msg.kind === "user" ? "user_turn" : "agent_text",
          id: `${msg.kind}-${msg.seq}`,
          text: msg.content,
        });
      }
      continue;
    }

    let idx = 0;
    for (const part of msg.parts) {
      const id = `${msg.kind}-${msg.seq}-${idx++}`;
      if (part.type === "text") {
        if (!part.text) continue;
        items.push({
          kind: msg.kind === "user" ? "user_turn" : "agent_text",
          id,
          text: part.text,
        });
      } else if (part.type === "reasoning") {
        if (part.text.trim()) {
          items.push({
            kind: "thinking",
            id,
            text: part.text,
            streaming: false,
          });
        }
      } else if (part.type === "tool_call") {
        const awaiting = pending?.toolUseId === part.id ? pending : null;
        const decided = decisionFor(
          part.name,
          part.id,
          results.has(part.id) && awaiting === null,
        );
        items.push(
          toolCallCard({
            toolUseId: part.id,
            toolName: part.name,
            input: part.input,
            state: toolCallState(
              part.name,
              results.get(part.id),
              awaiting !== null,
              decided,
              outcomes.get(part.id),
            ),
            priorRuns: priorRunsOf(part.name, part.input, approved),
            // A decided call stays an approval card so its outcome has somewhere
            // to render, not just the tool output it produced.
            ...(awaiting ? { awaitingKind: awaiting.kind } : {}),
            ...(!awaiting && decided !== null
              ? { awaitingKind: "approval" as const }
              : {}),
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

  return items;
}
