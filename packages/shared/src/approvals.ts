export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "context_added"
  | "answered"
  | "continued";

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string; // Anthropic tool_use_id — correlation key
  kind?: "approval" | "clarification" | "continue";
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface ApprovalResponse {
  sessionId: string;
  toolUseId: string;
  status: ApprovalStatus;
  resolvedBy: string;
  resolvedAt: string;
}

export interface RespondRequest {
  decision?: "approve" | "reject";
  text?: string;
  resolvedBy?: string;
}
