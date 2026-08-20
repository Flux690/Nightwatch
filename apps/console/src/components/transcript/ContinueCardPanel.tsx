import { Button } from "@/components/ui/button";
import type { ContinueCardItem } from "./types.js";
import { InterruptCard } from "./InterruptCard.js";

export function ContinueCardPanel({
  item,
  submitting = false,
  onResolve,
}: {
  item: ContinueCardItem;
  submitting?: boolean;
  onResolve?: (action: "approve" | "reject") => void;
}): React.JSX.Element {
  const state = item.state;

  return (
    <InterruptCard data-testid="continue-card">
      <p className="text-sm">
        Time budget reached. Resume with a fresh budget or end the
        investigation.
      </p>
      {state.phase === "resolved" ? (
        <p className="text-sm" data-testid="continue-resolution">
          {state.decision === "continued" ? "Continued" : "Cancelled"}
        </p>
      ) : (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={submitting}
            onClick={() => onResolve?.("approve")}
          >
            Continue
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={submitting}
            onClick={() => onResolve?.("reject")}
          >
            Cancel
          </Button>
        </div>
      )}
    </InterruptCard>
  );
}
