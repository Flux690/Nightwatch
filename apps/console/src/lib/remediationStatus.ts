import type { RemediationStatus } from "@nightwarden/shared";
import type { StatusTone } from "@/components/ui/status";

// One vocabulary shared by the audit log and the report's action list, so the same
// row cannot read as "Ran" on one screen and "Executed" on another. Past tense
// throughout: the executor writes every one of these after the fact.
export const ACTION_LABEL: Record<RemediationStatus, string> = {
  executed: "Ran",
  failed: "Failed",
  rejected: "Declined",
  executing: "Running",
};

export const ACTION_TONE: Record<RemediationStatus, StatusTone> = {
  executed: "ok",
  failed: "fail",
  rejected: "muted",
  executing: "run",
};
