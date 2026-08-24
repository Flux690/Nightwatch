// Two outcomes only: a rejection carries the user's comment back, so there is
// no third "added context" for the agent to read as success.
export type ApprovalStatus =
  "pending" | "approved" | "rejected" | "answered" | "continued";

export interface ApprovalRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string; // Anthropic tool_use_id — correlation key
  kind?: "approval" | "clarification" | "continue";
  status: ApprovalStatus;
  resolvedAt?: string;
}

export interface ApprovalResponse {
  sessionId: string;
  toolUseId: string;
  status: ApprovalStatus;
  resolvedAt: string;
}

export interface RespondRequest {
  decision?: "approve" | "reject";
  text?: string;
}
