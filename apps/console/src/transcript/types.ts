export type TranscriptItem =
  | UserTurnItem
  | AgentTextItem
  | ToolCardItem
  | ApprovalCardItem
  | ClarificationCardItem;

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
}
