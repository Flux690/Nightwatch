import { Button } from "@/components/ui/button";
import type { ApprovalCardItem } from "./types.js";
import { ToolCardPanel } from "./ToolCardPanel.js";
import { InterruptCard } from "./InterruptCard.js";

export function ApprovalCardPanel({
  item,
  onResolve,
}: {
  item: ApprovalCardItem;
  onResolve?: (action: "approve" | "reject") => void;
}): React.JSX.Element {
  const resolved = item.approval === "approved" || item.approval === "rejected";

  return (
    <>
      <InterruptCard data-testid="approval-card" resolved={resolved}>
        <p className="font-mono text-sm font-medium">{item.toolName}</p>
        <p className="text-xs text-muted-foreground">
          Risk: {item.risk ?? "unknown"}
        </p>
        {resolved ? (
          <p className="text-sm" data-testid="approval-resolution">
            {item.approval === "approved" ? "Approved" : "Rejected"}
            {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
          </p>
        ) : (
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={item.approval === "pending"}
              onClick={() => onResolve?.("approve")}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={item.approval === "pending"}
              onClick={() => onResolve?.("reject")}
            >
              Reject
            </Button>
          </div>
        )}
      </InterruptCard>
      {resolved && (
        <ToolCardPanel
          toolName={item.toolName}
          input={item.input}
          result={item.result}
        />
      )}
    </>
  );
}
