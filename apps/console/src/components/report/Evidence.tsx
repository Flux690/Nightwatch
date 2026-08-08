import type { NormalizedAlert, ResolvedEvidence } from "@nightwarden/shared";
import { cn } from "@/lib/utils";
import { asRecord } from "@/lib/toolResult";
import { revealToolCall } from "@/components/transcript/revealToolCall";
import { quoteLine } from "@/components/transcript/toolFindings";
import { Button } from "@/components/ui/button";
import {
  ToolBody,
  resultSummary,
  targetOf,
} from "@/components/transcript/toolPresentation";
import { ChangesList, pullRequestsFrom } from "./ChangesList.js";
import { Measurement } from "./Measurement.js";
import { plotFrom } from "./plot.js";

/* The reading lifts the worst line out of a log; the body below quotes the log
   in order. When the worst line is also the first, the two land on adjacent rows
   and one event reads as two, so the body carries it alone. */
function bodyOpensWithTheReading(result: string, reading: string): boolean {
  const record = asRecord(result);
  const lines = record === null ? null : record["lines"];
  const first = Array.isArray(lines) ? lines[0] : null;
  if (typeof first !== "string" || first.trim() === "") return false;
  return reading.includes(quoteLine(first));
}

/* One cited tool call, quoted under the claim it backs. The reading leads
   because that is what the claim rests on; the result follows. Every value came
   from the recorded call, so checking a claim is reading rather than trusting. */
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
  // requests, quoted otherwise. Every branch ends in something on screen: a
  // result we cannot draw is still a result the operator came here to read.
  const plot = plotFrom(entry.result, alert);
  const pullRequests = pullRequestsFrom(entry.result);
  // A one-line plain result is already stated in full by the reading above it,
  // so quoting it underneath would print the same sentence twice.
  const worthQuoting =
    asRecord(entry.result) !== null || entry.result.includes("\n");
  const quotedBelow =
    plot === null && pullRequests.length === 0 && worthQuoting;
  const showSummary =
    summary.text !== "" &&
    !(quotedBelow && bodyOpensWithTheReading(entry.result, summary.text));

  return (
    <div className="mt-2 border-l border-border pl-3">
      {header}
      {showSummary && (
        <p className={cn("m-0 mt-1 font-mono text-sm", summary.tone)}>
          {summary.text}
        </p>
      )}
      {(plot !== null || pullRequests.length > 0 || worthQuoting) && (
        <div className="mt-2 text-muted-foreground">
          {plot !== null ? (
            <Measurement plot={plot} />
          ) : pullRequests.length > 0 ? (
            <ChangesList pullRequests={pullRequests} />
          ) : (
            <ToolBody
              toolName={entry.toolName}
              input={entry.input}
              result={entry.result}
            />
          )}
        </div>
      )}
    </div>
  );
}
