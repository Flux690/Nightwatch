import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ReportCardItem } from "./types.js";
import { openReport } from "./openReport.js";

/* The end of the run, drawn the way the transcript draws any other fact about
   the run: a rule the label rides. This one is last and nothing renders below
   it, which is what reads as an ending without a word spent on it. */

/* Not a card. The report is not in here - this is the door to it, and a filled
   panel would promise content it does not hold. Cobalt only once it is ready,
   because that is the one moment there is something to act on. */
const PHASE: Record<
  ReportCardItem["state"]["phase"],
  { label: string; rule: string; ink: string }
> = {
  building: {
    label: "Writing the investigation report",
    rule: "bg-border",
    ink: "text-muted-foreground",
  },
  ready: {
    label: "Report ready",
    rule: "bg-primary-ink",
    ink: "text-foreground",
  },
  failed: {
    label: "The report was not written",
    rule: "bg-fail",
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
  const { label, rule, ink } = PHASE[phase];

  return (
    <div
      role="status"
      data-testid="report-card"
      data-phase={phase}
      className="animate-in fade-in flex items-center gap-3 py-1 text-sm duration-(--duration-slow)"
    >
      <span aria-hidden className={cn("h-px w-6 shrink-0", rule)} />
      <span
        className={cn(
          "shrink-0 font-medium whitespace-nowrap",
          ink,
          phase === "building" && "shimmer",
        )}
      >
        {label}
      </span>
      <span aria-hidden className={cn("h-px min-w-0 flex-1", rule)} />
      {/* Ready waits to be clicked: a run ending must not swap the view out
          from under whoever is mid-sentence. */}
      {phase === "ready" && (
        <Button size="sm" className="shrink-0" onClick={() => openReport()}>
          Open report
        </Button>
      )}
      {/* Why it was not written is the error notice above, which is where every
          other failure in the run explains itself. */}
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
