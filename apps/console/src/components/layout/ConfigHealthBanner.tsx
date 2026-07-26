import { useNavigate } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { useConfigHealth } from "@/hooks/useConfigHealth";

// App-wide setup warnings, shown above every view so a misconfiguration can't be
// missed. Renders nothing when healthy.
export function ConfigHealthBanner(): React.JSX.Element | null {
  const navigate = useNavigate();
  const { data } = useConfigHealth();
  const issues = data?.issues ?? [];
  if (issues.length === 0) return null;

  return (
    <div className="shrink-0 divide-y divide-border border-b border-border">
      {issues.map((issue) => (
        <Alert
          key={issue.kind}
          variant="warning"
          className="rounded-none border-0"
        >
          <TriangleAlert />
          <AlertDescription>
            {issue.message}{" "}
            <button
              type="button"
              className="font-medium underline underline-offset-3 hover:text-foreground"
              onClick={() => void navigate({ to: issue.href })}
            >
              Fix
            </button>
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}
