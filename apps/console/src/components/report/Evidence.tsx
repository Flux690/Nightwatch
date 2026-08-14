import type { NormalizedAlert, ResolvedEvidence } from "@nightwarden/shared";
import { cn } from "@/lib/utils";
import { revealToolCall } from "@/components/transcript/revealToolCall";
import { Button } from "@/components/ui/button";
import {
  resultSummary,
  targetOf,
} from "@/components/transcript/toolPresentation";
import { ChangesList, pullRequestsFrom } from "./ChangesList.js";
import { Measurement } from "./Measurement.js";
import { plotFrom } from "./plot.js";

/* Readings only: a chart, a list of merged changes, or the one line the result
   amounts to. The raw body is deliberately absent - a report that quotes two
   hundred log lines is a transcript with extra steps, one click away. */
export function Evidence({
  entry,
  alert,
  repeat = false,
}: {
  entry: ResolvedEvidence;
  alert: NormalizedAlert | null;
  // The same call cited by a later claim. It is named and linked, never drawn a
  // second time: one call's chart down the page three times reads as three
  // measurements.
  repeat?: boolean;
}): React.JSX.Element {
  const target = targetOf(entry.input);

  const header = (
    <div className="flex items-baseline gap-2">
      <span className="font-mono text-sm text-ink-subtle">
        {entry.toolName}
      </span>
      {target && (
        <span className="min-w-0 truncate font-mono text-sm text-muted-foreground">
          {target}
        </span>
      )}
      {repeat && (
        <span className="text-sm text-muted-foreground">shown above</span>
      )}
      <Button
        variant="link"
        className="ml-auto"
        onClick={() => revealToolCall(entry.toolUseId)}
      >
        Show in transcript
      </Button>
    </div>
  );

  if (repeat) {
    return <div className="mt-2 border-l border-border pl-3">{header}</div>;
  }

  const summary = resultSummary(entry.toolName, entry.result, entry.outcome);
  // Drawn when the result holds a measurement, listed when it holds merged pull
  // requests, and otherwise left to the reading alone.
  const plot = plotFrom(entry.result, alert);
  const pullRequests = pullRequestsFrom(entry.result);

  return (
    <div className="mt-2 border-l border-border pl-3">
      {header}
      {summary.text !== "" && (
        <p className={cn("m-0 mt-1 font-mono text-sm", summary.tone)}>
          {summary.text}
        </p>
      )}
      {(plot !== null || pullRequests.length > 0) && (
        <div className="mt-2 text-muted-foreground">
          {plot !== null ? (
            <Measurement plot={plot} />
          ) : (
            <ChangesList pullRequests={pullRequests} />
          )}
        </div>
      )}
    </div>
  );
}
