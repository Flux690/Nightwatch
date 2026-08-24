import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import { cn } from "@/shared/lib/utils";
import { TOOL_CARD_CLASS } from "./cardChrome.js";
import type { ReportCardItem } from "./types.js";
import { openReport } from "./openReport.js";

/* Drawn as a surface, not a rule. A rule read as an ending when it was always
   last; docked, it is a standing object the run keeps rewriting. */

const PHASE: Record<
  ReportCardItem["state"]["phase"],
  { label: string; note: string; ink: string }
> = {
  building: {
    label: "Investigation report",
    note: "Writing it up",
    ink: "text-muted-foreground",
  },
  ready: {
    label: "Investigation report",
    note: "Ready to read",
    ink: "text-foreground",
  },
  failed: {
    label: "Investigation report",
    note: "Not written",
    ink: "text-fail",
  },
};

export function ReportCardPanel({
  item,
  retrying = false,
  onRetry,
}: {
  item: ReportCardItem;
  retrying?: boolean;
  onRetry?: () => void;
}): React.JSX.Element {
  const phase = item.state.phase;
  const { label, note, ink } = PHASE[phase];

  return (
    <div
      role="status"
      data-testid="report-card"
      data-phase={phase}
      className={cn(
        TOOL_CARD_CLASS,
        "animate-in fade-in flex items-center gap-3 rounded-lg bg-card px-4 duration-(--duration-slow)",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className={cn("text-xs", ink, phase === "building" && "shimmer")}>
          {note}
        </span>
      </div>
      {/* Ready waits to be clicked: a run ending must not swap the view out
          from under whoever is mid-sentence. */}
      {phase === "ready" && (
        <Button size="sm" className="shrink-0" onClick={() => openReport()}>
          Open report
        </Button>
      )}
      {/* Why it was not written is the error notice in the transcript, which is
          where every other failure in the run explains itself. */}
      {phase === "failed" && (
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          disabled={retrying}
          onClick={() => onRetry?.()}
        >
          {retrying && <Spinner className="size-4" />}
          Try again
        </Button>
      )}
    </div>
  );
}
