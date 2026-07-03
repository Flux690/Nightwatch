import { Button } from "../ui/Button.js";
import { Text } from "../ui/Text.js";
import type { ApprovalCardItem } from "./types.js";
import { ToolCardPanel } from "./ToolCardPanel.js";

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
      <div
        data-testid="approval-card"
        className="interrupt-card"
        data-resolved={resolved || undefined}
      >
        <Text className="text-sm font-mono font-medium">{item.toolName}</Text>
        <Text className="text-xs text-ink-muted">
          Risk: {item.risk ?? "unknown"}
        </Text>
        {resolved ? (
          <Text className="text-sm" data-testid="approval-resolution">
            {item.approval === "approved" ? "Approved" : "Rejected"}
            {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
          </Text>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
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
      </div>
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
