export type TranscriptItem =
  | UserTurnItem
  | AgentTextItem
  | ErrorTextItem
  | ThinkingItem
  | ToolCardItem
  | ApprovalCardItem
  | ClarificationCardItem
  | ContinueCardItem;

export interface UserTurnItem {
  kind: "user_turn";
  id: string;
  text: string;
}

export interface AgentTextItem {
  kind: "agent_text";
  id: string;
  text: string;
}

// Nightwatch's own failure note (role "error"), rendered exactly like agent text.
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
  result: unknown | null;
}

export interface ApprovalCardItem {
  kind: "approval_card";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: unknown | null;
  risk?: string;
  approval?: "pending" | "approved" | "rejected";
  resolvedBy?: string;
}

export interface ClarificationCardItem {
  kind: "clarification_card";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  question?: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
  approval?: "pending" | "answered";
  resolvedBy?: string;
  // The human's answer: stashed live at submit time, reconstructed from the
  // persisted tool_result on reload.
  result?: unknown;
}

export interface ContinueCardItem {
  kind: "continue_card";
  toolUseId: string;
  approval?: "pending" | "continued" | "rejected";
  resolvedBy?: string;
}
