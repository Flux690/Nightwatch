import type { ApprovalStatus } from "./approvals.js";

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
      by?: string;
      result?: unknown;
    }
  | { phase: "complete"; result: unknown };

// A resolved [evidence: eN] marker: the tool call it points at. Markers that
// resolve to nothing are left as literal text rather than linked.
export interface Citation {
  tag: string;
  toolUseId: string;
  toolName: string;
}

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
  // Keyed by tag, for the markers left inline in `text`.
  citations?: Record<string, Citation>;
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
  // How often this exact write already landed recently, computed from the audit log.
  // Present only when it has happened before; the card informs, it never refuses.
  recent?: { count: number; windowMinutes: number };
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

export type TranscriptItem =
  | UserTurnItem
  | AgentTextItem
  | ErrorTextItem
  | ThinkingItem
  | ToolCardItem
  | ApprovalCardItem
  | ClarificationCardItem
  | ContinueCardItem;

// Stable identity for a card, so a live update finds the item it belongs to.
export function transcriptItemKey(item: TranscriptItem): string {
  return "toolUseId" in item ? item.toolUseId : item.id;
}
