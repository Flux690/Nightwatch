import "./StatusChip.css";

import React from "react";

type StatusColor = "running" | "awaiting" | "failed" | "neutral";
type StatusDomain = "runner" | "session" | "remediation" | "alert";

const colorMap: Record<StatusDomain, Record<string, StatusColor>> = {
  runner: {
    online: "running",
    connecting: "awaiting",
    offline: "neutral",
  },
  session: {
    running: "running",
    "awaiting-approval": "awaiting",
    "awaiting-input": "awaiting",
    "continue-requested": "awaiting",
    completed: "neutral",
    failed: "failed",
    stopped: "neutral",
  },
  remediation: {
    executing: "awaiting",
    executed: "running",
    failed: "failed",
    rejected: "neutral",
    unknown: "neutral",
  },
  alert: {
    resolved: "running",
    unresolved: "awaiting",
  },
};

function resolveColor(domain: StatusDomain, status: string): StatusColor {
  return colorMap[domain][status] ?? "neutral";
}

export function StatusChip({
  status,
  domain,
}: {
  status: string;
  domain: StatusDomain;
}): React.JSX.Element {
  const color = resolveColor(domain, status);

  return (
    <span className="status-chip" data-color={color}>
      <span className="status-chip__dot" />
      <span className="status-chip__label">{status}</span>
    </span>
  );
}
