import { Button } from "@/components/ui/button";
import type { ApprovalCardItem } from "./types.js";
import { ToolCard } from "./toolPresentation.js";
import { InterruptCard } from "./InterruptCard.js";

export function ApprovalCardPanel({
  item,
  submitting = false,
  onResolve,
}: {
  item: ApprovalCardItem;
  // A decision already sent and awaiting its reply. Belongs to the component,
  // not the transcript: it describes this browser, not the session.
  submitting?: boolean;
  onResolve?: (action: "approve" | "reject") => void;
}): React.JSX.Element {
  const state = item.state;
  const resolved = state.phase === "resolved";

  return (
    <>
      <InterruptCard data-testid="approval-card" resolved={resolved}>
        <p className="font-mono text-sm font-medium">{item.toolName}</p>
        <p className="text-sm text-muted-foreground">
          Risk: {item.risk ?? "unknown"}
        </p>
        {state.phase === "resolved" ? (
          <p className="text-sm" data-testid="approval-resolution">
            {state.decision === "approved" ? "Approved" : "Rejected"}
            {state.by ? ` by ${state.by}` : ""}
          </p>
        ) : (
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={submitting}
              onClick={() => onResolve?.("approve")}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={submitting}
              onClick={() => onResolve?.("reject")}
            >
              Reject
            </Button>
          </div>
        )}
      </InterruptCard>
      {state.phase === "resolved" && (
        <ToolCard
          item={{
            kind: "tool_card",
            toolUseId: item.toolUseId,
            toolName: item.toolName,
            input: item.input,
            state:
              state.result === undefined
                ? { phase: "running" }
                : { phase: "complete", result: state.result },
          }}
        />
      )}
    </>
  );
}
