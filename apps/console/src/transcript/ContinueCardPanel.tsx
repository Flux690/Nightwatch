import { Button, Text } from "@mantine/core";
import type { ContinueCardItem } from "./types.js";

export function ContinueCardPanel({
  item,
  onResolve,
}: {
  item: ContinueCardItem;
  onResolve?: (action: "approve" | "reject") => void;
}): React.JSX.Element {
  const resolved =
    item.approval === "continued" || item.approval === "rejected";
  const disabled = item.approval === "pending";

  return (
    <div
      data-testid="continue-card"
      style={{
        border: "1px solid var(--nw-status-awaiting)",
        borderRadius: "var(--mantine-radius-sm)",
        background: "var(--nw-surface)",
        padding: "var(--mantine-spacing-xs)",
      }}
    >
      <Text size="xs" mb="xs">
        Time budget reached. Resume with a fresh budget or end the
        investigation.
      </Text>
      {resolved ? (
        <Text size="xs" data-testid="continue-resolution">
          {item.approval === "continued" ? "Resumed" : "Ended"}
          {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
        </Text>
      ) : (
        <div style={{ display: "flex", gap: "var(--mantine-spacing-xs)" }}>
          <Button
            size="xs"
            color="streaming"
            disabled={disabled}
            onClick={() => onResolve?.("approve")}
          >
            Resume
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => onResolve?.("reject")}
          >
            End investigation
          </Button>
        </div>
      )}
    </div>
  );
}
