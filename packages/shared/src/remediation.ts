export type RemediationStatus =
  | "executing"
  | "executed"
  | "failed"
  | "rejected";

// Wire shape for the audit log: one row per write the agent attempted, with the
// operator's decision and its outcome (ADR-0003).
export interface RemediationActionRecord {
  sessionId: string;
  toolUseId: string;
  serviceIdentityKey: string | null;
  toolName: string;
  status: RemediationStatus;
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
