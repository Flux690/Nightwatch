import type {
  AlertSeverity,
  SessionListRow,
  SessionRunStatus,
} from "@nightwarden/shared";

// Triage order: what needs a person, then what is still moving, then the three
// kinds of finished. The group headers and the record's stepper share it, so
// stepping through the queue walks the list exactly as it was read.
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

// An unrankable word sorts last without claiming to be the lowest severity.
const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function rankOf(severity: AlertSeverity | null): number {
  return severity === null ? SEVERITY_RANK.info + 1 : SEVERITY_RANK[severity];
}

interface StatusGroup {
  status: SessionRunStatus;
  rows: SessionListRow[];
}

// Non-empty groups only, in triage order, each sorted by severity. Sort is
// stable, so rows of equal severity keep the order the API sent them in.
export function groupByStatus(rows: SessionListRow[]): StatusGroup[] {
  return STATUS_ORDER.map((status) => ({
    status,
    rows: rows
      .filter((row) => row.status === status)
      .sort((a, b) => rankOf(a.severity) - rankOf(b.severity)),
  })).filter((group) => group.rows.length > 0);
}

// The grouped list flattened: the sequence the record steps through.
export function investigationQueue(rows: SessionListRow[]): SessionListRow[] {
  return groupByStatus(rows).flatMap((group) => group.rows);
}
