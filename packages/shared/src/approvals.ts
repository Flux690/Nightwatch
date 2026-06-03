export type ApprovalStatus = "pending" | "approved" | "rejected" | "context_added";

export interface ApprovalRequest {
  id: string;
  incidentId: string;
  installationId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string; // Anthropic tool_use_id — correlation key
  status: ApprovalStatus;
  comment?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface ApprovalDecision {
  toolUseId: string;
  action: "approve" | "reject" | "add_context";
  comment?: string;
  contextMessage?: string; // for add_context — injected as user message
}

export interface ApprovalResponse {
  incidentId: string;
  toolUseId: string;
  status: ApprovalStatus;
  resolvedBy: string;
  resolvedAt: string;
}
