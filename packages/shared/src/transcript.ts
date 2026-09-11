// Built server-side from the stored transcript joined with whatever the session
// is suspended on. The browser draws these and never derives a call's state.

import type { ApprovalStatus } from "./approvals.js";
import type { Verdict } from "./reports.js";

// Named as the gate names it, so there is one vocabulary. It lives on the one
// phase where it means anything, so a settled call cannot contradict it.
export type ToolGate = "approval" | "clarification";

// Explicit rather than an optional field, so "not set" is never a meaning. A
// decision in flight is the component's own concern and never appears here.
export type ToolCallState =
  | { phase: "running" }
  | { phase: "awaiting_human"; gate: ToolGate }
  // A human decided; `result` arrives once the tool that was waiting has run.
  | { phase: "resolved"; decision: ApprovalStatus; result?: unknown }
  | { phase: "complete"; result: unknown };

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

// One item for the whole life of a call, its state saying which moment it is
// in. Arguments travel whole in `input`, because a copy is a second source.
export interface ToolCallItem {
  kind: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  // How many times this same write already ran, counted from the transcript.
  // The card informs, it never refuses; only a walk can answer it.
  priorRuns?: number;
  state: ToolCallState;
}

// Not a tool call: no model asked for it, and its synthetic id keys an
// interrupt row. So it carries two states rather than a tool's four.
export interface ContinueCardItem {
  kind: "continue_card";
  toolCallId: string;
  state:
    | { phase: "awaiting_human" }
    | { phase: "resolved"; decision: ApprovalStatus };
}

// `building` is live only, being the phase of a turn in flight; the other two
// are read back from whether the session holds a report.
export interface ReportCardItem {
  kind: "report_card";
  id: string;
  state: { phase: "building" | "ready" | "failed" };
  // The report's own headline, carried so the card names what it opens. Present
  // once a report stands; absent on a first build and on a failure.
  headline?: string;
}

// One row of the candidate board: what was weighed, where it stands, and the
// finding's own words when it settled.
export interface CandidateRow {
  statement: string;
  // "open" while untested, "reopened" once a settling finding was superseded,
  // otherwise the verdict of the finding that settled it.
  state: "open" | "reopened" | Verdict;
  note?: string;
}

// The candidate board, placed where OpenCandidates ran and refreshed as findings
// settle or reopen them. One per session, keyed on its id like the report card.
export interface CandidateCardItem {
  kind: "candidate_card";
  id: string;
  rows: CandidateRow[];
}

// Placed where it interrupted. The report holds the detail; this says only
// that the ground moved, so a change of course has a visible cause.
export interface AlertArrivedItem {
  kind: "alert_arrived";
  id: string;
  alertType: string;
  // Whatever the sender called it, verbatim. Null when it carried no label.
  severityLabel: string | null;
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
  | CandidateCardItem
  | AlertArrivedItem
  | CompactionItem;

// Stable identity for a card, so a live update finds the item it belongs to.
export function transcriptItemKey(item: TranscriptItem): string {
  return "toolCallId" in item ? item.toolCallId : item.id;
}
