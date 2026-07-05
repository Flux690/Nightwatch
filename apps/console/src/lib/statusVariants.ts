import type { VariantProps } from "class-variance-authority";

import type { badgeVariants } from "@/components/ui/badge";

export type BadgeVariant = NonNullable<
  VariantProps<typeof badgeVariants>["variant"]
>;

export type StatusDomain = "runner" | "session" | "remediation" | "alert";

type StatusEntry = { variant: BadgeVariant; label: string };

function labelFor(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/-/g, " ");
}

const RUNNER: Record<string, StatusEntry> = {
  online: { variant: "success", label: "Online" },
  connecting: { variant: "warning", label: "Connecting" },
  offline: { variant: "secondary", label: "Offline" },
};

const SESSION: Record<string, StatusEntry> = {
  running: { variant: "success", label: "Running" },
  "awaiting-approval": { variant: "warning", label: "Awaiting approval" },
  "awaiting-input": { variant: "warning", label: "Awaiting input" },
  "continue-requested": { variant: "warning", label: "Continue requested" },
  completed: { variant: "secondary", label: "Completed" },
  failed: { variant: "destructive", label: "Failed" },
  stopped: { variant: "secondary", label: "Stopped" },
};

const REMEDIATION: Record<string, StatusEntry> = {
  executing: { variant: "warning", label: "Executing" },
  executed: { variant: "success", label: "Executed" },
  failed: { variant: "destructive", label: "Failed" },
  rejected: { variant: "secondary", label: "Rejected" },
  unknown: { variant: "secondary", label: "Unknown" },
};

const ALERT: Record<string, StatusEntry> = {
  resolved: { variant: "success", label: "Resolved" },
  unresolved: { variant: "warning", label: "Unresolved" },
  critical: { variant: "destructive", label: "Critical" },
  warning: { variant: "warning", label: "Warning" },
  info: { variant: "secondary", label: "Info" },
};

const MAPS: Record<StatusDomain, Record<string, StatusEntry>> = {
  runner: RUNNER,
  session: SESSION,
  remediation: REMEDIATION,
  alert: ALERT,
};

const FALLBACK: StatusEntry = { variant: "secondary", label: "" };

export function statusVariant(
  domain: StatusDomain,
  status: string,
): StatusEntry {
  const entry = MAPS[domain][status];
  if (entry) return entry;
  return { variant: "secondary", label: labelFor(status) };
}
