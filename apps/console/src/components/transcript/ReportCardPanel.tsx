import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ICON_UI } from "@/lib/iconProps";
import type { ReportCardItem } from "./types.js";
import { InterruptCard } from "./InterruptCard.js";
import { openReport } from "./openReport.js";

/* The turn that produces the report belongs in the same column as the turns
   before it. Nothing opens on its own: a report that slides in over the message
   being read is the page moving under the reader. */
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

  if (phase === "building") {
    return (
      <div
        role="status"
        data-testid="report-card"
        data-phase="building"
        className="animate-in fade-in flex items-center gap-2 py-1 text-sm text-muted-foreground duration-(--duration-slow)"
      >
        <Spinner className="size-4" />
        <span className="shimmer">Writing the investigation report</span>
      </div>
    );
  }

  if (phase === "ready") {
    return (
      <InterruptCard data-testid="report-card" data-phase="ready">
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <FileText {...ICON_UI} className="shrink-0 text-muted-foreground" />
            The investigation report is ready
          </span>
          <Button size="sm" className="shrink-0" onClick={() => openReport()}>
            Open report
          </Button>
        </div>
      </InterruptCard>
    );
  }

  return (
    <InterruptCard data-testid="report-card" data-phase="failed">
      <div className="flex items-center justify-between gap-3">
        {/* Why it was not written is the error notice above this card, which is
            where every other failure in the run explains itself. */}
        <span className="min-w-0 text-sm">The report was not written.</span>
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
      </div>
    </InterruptCard>
  );
}
