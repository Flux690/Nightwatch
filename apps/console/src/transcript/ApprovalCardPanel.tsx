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
        style={{
          border: "1px solid var(--color-status-awaiting)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-surface)",
          padding: 4,
          marginBottom: 4,
        }}
      >
        <Text className="text-xs font-mono font-semibold">{item.toolName}</Text>
        <Text className="text-xs text-ink-muted mb-2">
          Risk: {item.risk ?? "unknown"}
        </Text>
        {resolved ? (
          <Text className="text-xs" data-testid="approval-resolution">
            {item.approval === "approved" ? "Approved" : "Rejected"}
            {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
          </Text>
        ) : (
          <div style={{ display: "flex", gap: 4 }}>
            <Button
              size="xs"
              disabled={item.approval === "pending"}
              onClick={() => onResolve?.("approve")}
            >
              Approve
            </Button>
            <Button
              size="xs"
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
