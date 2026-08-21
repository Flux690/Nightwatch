import type { AlertSeverity } from "./alerts.js";
import type { ApprovalStatus } from "./approvals.js";
import type { ToolOutcome } from "./messages.js";

// What the console renders, built server-side from the stored transcript joined
// with whatever the session is suspended on. The browser draws these; it never
// works out what state a tool call is in.

/* What a suspended call needs from a person, named as the gate names it so there
   is one vocabulary. It lives on the one phase where it means anything, so it
   cannot disagree with a call that has settled. */
export type ToolGate = "approval" | "clarification";

// Explicit rather than an optional field, so "not set" is never a meaning. A
// decision in flight is the component's own concern and never appears here.
export type ToolCallState =
  | { phase: "running" }
  | { phase: "awaiting_human"; gate: ToolGate }
  // A human decided; `result` arrives once the tool that was waiting has run.
  | {
      phase: "resolved";
      decision: ApprovalStatus;
      result?: unknown;
      toolOutcome?: ToolOutcome;
    }
  | { phase: "complete"; result: unknown; toolOutcome?: ToolOutcome };

export interface UserTurnItem {
  kind: "user_turn";
  id: string;
  text: string;
  // The settled copy of a just-echoed bubble: rendered without the mount fade
  // so the echo-to-persisted swap is invisible.
  instant?: boolean;
}

export interface AgentTextItem {
  kind: "agent_text";
  id: string;
  text: string;
  // Which turn wrote it; a streamed copy carries the same number.
  turn: number;
}

// NightWarden's own failure note (role "error"), rendered exactly like agent text.
export interface ErrorTextItem {
  kind: "error_text";
  id: string;
  text: string;
}

export interface ThinkingItem {
  kind: "thinking";
  id: string;
  text: string;
  // True only while live deltas are still arriving for this burst; reload-path
  // items are never streaming, and either way it renders collapsed until opened.
  streaming: boolean;
  turn: number;
}

/* One item for the whole life of a tool call, with the state carrying which
   moment it is in, so nothing can label a call as something its state
   contradicts. Arguments travel whole in `input`: a copy is a second source. */
export interface ToolCallItem {
  kind: "tool_call";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  // How many times this same write already ran, counted from the transcript.
  // The card informs, it never refuses; only a walk can answer it.
  priorRuns?: number;
  state: ToolCallState;
}

/* Not a tool call: the harness raises it when the time budget runs out, no model
   asked for it, and its synthetic id keys an interrupt row rather than any turn.
   So it carries the two states it can actually be in, never a tool's four. */
export interface ContinueCardItem {
  kind: "continue_card";
  toolUseId: string;
  state:
    | { phase: "awaiting_human" }
    | { phase: "resolved"; decision: ApprovalStatus };
}

/* In the transcript rather than beside it: the report is produced by a turn like
   any other. `building` is live only, being the phase of a turn in flight; the
   other two are read back from whether the session holds a report. */
export interface ReportCardItem {
  kind: "report_card";
  id: string;
  state: { phase: "building" | "ready" | "failed" };
}

// An alert that fired while the run was already working, placed where it
// interrupted. The report holds the detail; this says only that the ground
// moved here, so the agent changing course has a visible cause.
export interface AlertArrivedItem {
  kind: "alert_arrived";
  id: string;
  alertType: string;
  severity: AlertSeverity | null;
}

// Where the provider summarised everything above to fit its window. The
// evidence is untouched: a compacted tool result is still in the record.
export interface CompactionItem {
  kind: "compaction";
  id: string;
}

export type TranscriptItem =
  | UserTurnItem
  | AgentTextItem
  | ErrorTextItem
  | ThinkingItem
  | ToolCallItem
  | ContinueCardItem
  | ReportCardItem
  | AlertArrivedItem
  | CompactionItem;

// Stable identity for a card, so a live update finds the item it belongs to.
export function transcriptItemKey(item: TranscriptItem): string {
  return "toolUseId" in item ? item.toolUseId : item.id;
}
