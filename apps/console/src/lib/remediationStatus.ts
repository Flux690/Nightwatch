import type { RemediationStatus } from "@nightwarden/shared";
import type { StatusTone } from "@/components/ui/status";

// One vocabulary for an action's outcome, shared by the audit log and the
// report's action list. Both read the same rows, so they must not describe them
// differently: an action the audit log calls "Ran" cannot read as "Executed"
// two screens away.
//
// Past tense throughout, because every one of these is written by the executor
// after the fact. Nothing here is a prediction.
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
