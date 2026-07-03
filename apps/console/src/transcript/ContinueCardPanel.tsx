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
      className="interrupt-card"
      data-resolved={resolved || undefined}
    >
      <Text className="text-sm">
        Time budget reached. Resume with a fresh budget or end the
        investigation.
      </Text>
      {resolved ? (
        <Text className="text-sm" data-testid="continue-resolution">
          {item.approval === "continued" ? "Continued" : "Cancelled"}
          {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
        </Text>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => onResolve?.("approve")}
          >
            Continue
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => onResolve?.("reject")}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
