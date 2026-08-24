import type { SessionListRow, SessionRunStatus } from "@nightwarden/shared";

// The group headers and the record's stepper share this order, so stepping
// through the queue walks the list exactly as it was read.
const STATUS_ORDER: SessionRunStatus[] = [
  "action_required",
  "investigating",
  "resolved",
  "inconclusive",
  "stopped",
  "failed",
];

export const STATUS_LABEL: Record<SessionRunStatus, string> = {
  action_required: "Action required",
  investigating: "Investigating",
  resolved: "Resolved",
  inconclusive: "Inconclusive",
  stopped: "Stopped",
  failed: "Failed",
};

interface StatusGroup {
  status: SessionRunStatus;
  rows: SessionListRow[];
}

// Nothing reorders within a group: ranking a sender's own word would put a
// fleet labelling alerts P1 last for using a word we do not recognise.
export function groupByStatus(rows: SessionListRow[]): StatusGroup[] {
  return STATUS_ORDER.map((status) => ({
    status,
    rows: rows.filter((row) => row.status === status),
  })).filter((group) => group.rows.length > 0);
}

// The grouped list flattened: the sequence the record steps through.
export function investigationQueue(rows: SessionListRow[]): SessionListRow[] {
  return groupByStatus(rows).flatMap((group) => group.rows);
}
