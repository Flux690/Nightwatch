import { Button } from "@/components/ui/button";
import type { ContinueCardItem } from "./types.js";
import { InterruptCard } from "./InterruptCard.js";

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
    <InterruptCard data-testid="continue-card" resolved={resolved}>
      <p className="text-sm">
        Time budget reached. Resume with a fresh budget or end the
        investigation.
      </p>
      {resolved ? (
        <p className="text-sm" data-testid="continue-resolution">
          {item.approval === "continued" ? "Continued" : "Cancelled"}
          {item.resolvedBy ? ` by ${item.resolvedBy}` : ""}
        </p>
      ) : (
        <div className="flex gap-2">
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
    </InterruptCard>
  );
}
