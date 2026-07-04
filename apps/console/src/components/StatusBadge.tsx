import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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
    critical: "failed",
    warning: "awaiting",
    info: "neutral",
  },
};

const dotClass: Record<StatusColor, string> = {
  running: "bg-success",
  awaiting: "bg-warning",
  failed: "bg-destructive",
  neutral: "bg-muted-foreground",
};

const textClass: Record<StatusColor, string> = {
  running: "text-success",
  awaiting: "text-warning",
  failed: "text-destructive",
  neutral: "text-muted-foreground",
};

function labelFor(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/-/g, " ");
}

export function StatusBadge({
  status,
  domain,
}: {
  status: string;
  domain: StatusDomain;
}): React.JSX.Element {
  const color = colorMap[domain][status] ?? "neutral";
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border-transparent bg-transparent px-0 font-medium",
        textClass[color],
      )}
    >
      <span className={cn("size-2 rounded-full", dotClass[color])} />
      {labelFor(status)}
    </Badge>
  );
}
