import { Button } from "../ui/Button.js";
import { Text } from "../ui/Text.js";
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
        border: "1px solid var(--color-status-awaiting)",
        borderRadius: "var(--radius-sm)",
        background: "var(--color-surface)",
        padding: 4,
      }}
    >
      <Text className="text-xs mb-2">
        Time budget reached. Resume with a fresh budget or end the
        investigation.
      </Text>
      {resolved ? (
        <Text className="text-xs" data-testid="continue-resolution">
          {item.approval === "continued" ? "Resumed" : "Ended"}
          {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
        </Text>
      ) : (
        <div style={{ display: "flex", gap: 4 }}>
          <Button
            size="xs"
            disabled={disabled}
            onClick={() => onResolve?.("approve")}
          >
            Resume
          </Button>
          <Button
            size="xs"
            variant="secondary"
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
