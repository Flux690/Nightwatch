export type RemediationStatus =
  "executing" | "executed" | "failed" | "rejected";

// Wire shape for the audit log: one row per write the agent attempted, with the
// operator's decision and its outcome.
export interface RemediationActionRecord {
  sessionId: string;
  toolUseId: string;
  serviceIdentityKey: string | null;
  toolName: string;
  status: RemediationStatus;
  resolvedBy: string | null;
  // Why it ended that way, as the executor recorded it when the action settled.
  // Null while still executing. This is the reason a failed action failed, and
  // without it the operator can only see that something did.
  result: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
