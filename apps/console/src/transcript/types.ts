export type TranscriptItem =
  | UserTurnItem
  | AgentTextItem
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

export interface ThinkingItem {
  kind: "thinking";
  id: string;
  text: string;
  // streaming is true only while live deltas are still arriving for this
  // burst; reload-path items are never streaming. Always renders collapsed
  // by default (live and reload alike) - the operator opens it explicitly.
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
  // Present when reconstructed from a persisted, already-answered transcript -
  // the recorded tool_result, shown the same way ApprovalCardPanel nests a
  // resolved ToolCardPanel.
  result?: unknown;
}

export interface ContinueCardItem {
  kind: "continue_card";
  toolUseId: string;
  approval?: "pending" | "continued" | "rejected";
  resolvedBy?: string;
}
