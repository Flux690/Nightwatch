import { Button, Text } from "@mantine/core";
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
          border: "1px solid var(--nw-status-awaiting)",
          borderRadius: "var(--mantine-radius-sm)",
          background: "var(--nw-surface)",
          padding: "var(--mantine-spacing-xs)",
          marginBottom: "var(--mantine-spacing-xs)",
        }}
      >
        <Text size="xs" ff="monospace" fw={600}>
          {item.toolName}
        </Text>
        <Text size="xs" c="dimmed" mb="xs">
          Risk: {item.risk ?? "unknown"}
        </Text>
        {resolved ? (
          <Text size="xs" data-testid="approval-resolution">
            {item.approval === "approved" ? "Approved" : "Rejected"}
            {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
          </Text>
        ) : (
          <div style={{ display: "flex", gap: "var(--mantine-spacing-xs)" }}>
            <Button
              size="xs"
              color="streaming"
              disabled={item.approval === "pending"}
              onClick={() => onResolve?.("approve")}
            >
              Approve
            </Button>
            <Button
              size="xs"
              color="escalated"
              variant="outline"
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
