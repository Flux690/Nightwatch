import type { AlertSeverity } from "./alerts.js";
import type { ApprovalStatus } from "./approvals.js";
import type { ToolOutcome } from "./messages.js";

// What the console renders, built server-side from the stored transcript joined
// with whatever the session is suspended on. The browser draws these; it never
// works out what state a tool call is in.

// Explicit rather than an optional field, so "not set" is never a meaning. A
// decision in flight is the component's own concern and never appears here.
export type ToolCallState =
  | { phase: "running" }
  | { phase: "awaiting_human" }
  // A human decided; `result` arrives once the tool that was waiting has run.
  | {
      phase: "resolved";
      decision: ApprovalStatus;
      result?: unknown;
      outcome?: ToolOutcome;
    }
  | { phase: "complete"; result: unknown; outcome?: ToolOutcome };

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
}

export interface ToolCardItem {
  kind: "tool_card";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  state: ToolCallState;
}

export interface ApprovalCardItem {
  kind: "approval_card";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  risk?: string;
  // How many times this same write already ran in this investigation, counted
  // from its transcript. Present only when it has happened before; the card
  // informs, it never refuses.
  priorRuns?: number;
  state: ToolCallState;
}

export interface ClarificationCardItem {
  kind: "clarification_card";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  question?: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
  state: ToolCallState;
}

export interface ContinueCardItem {
  kind: "continue_card";
  toolUseId: string;
  state: ToolCallState;
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
  | ToolCardItem
  | ApprovalCardItem
  | ClarificationCardItem
  | ContinueCardItem
  | ReportCardItem
  | AlertArrivedItem
  | CompactionItem;

// Stable identity for a card, so a live update finds the item it belongs to.
export function transcriptItemKey(item: TranscriptItem): string {
  return "toolUseId" in item ? item.toolUseId : item.id;
}
