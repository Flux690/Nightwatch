import type { NormalizedAlert, ResolvedEvidence } from "@nightwarden/shared";
import { cn } from "@/lib/utils";
import { asRecord } from "@/lib/toolResult";
import { revealToolCall } from "@/components/transcript/revealToolCall";
import {
  ToolBody,
  resultSummary,
  targetOf,
} from "@/components/transcript/toolPresentation";
import { ChangesList, pullRequestsFrom } from "./ChangesList.js";
import { Measurement } from "./Measurement.js";
import { plotFrom } from "./plot.js";

/* One cited tool call, quoted under the claim it backs. The reading leads
   because that is what the claim rests on; the result follows. Every value came
   from the recorded call, so checking a claim is reading rather than trusting. */
export function Evidence({
  entry,
  alert,
}: {
  entry: ResolvedEvidence;
  alert: NormalizedAlert | null;
}): React.JSX.Element {
  const summary = resultSummary(entry.toolName, entry.result, entry.outcome);
  const target = targetOf(entry.input);
  // Drawn when the result holds a measurement, listed when it holds merged pull
  // requests, quoted otherwise. Every branch ends in something on screen: a
  // result we cannot draw is still a result the operator came here to read.
  const plot = plotFrom(entry.result, alert);
  const pullRequests = pullRequestsFrom(entry.result);
  // A one-line plain result is already stated in full by the reading above it,
  // so quoting it underneath would print the same sentence twice.
  const worthQuoting =
    asRecord(entry.result) !== null || entry.result.includes("\n");

  return (
    <div className="mt-2 border-l border-border pl-3">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-sm text-ink-subtle">
          {entry.toolName}
        </span>
        {target && (
          <span className="min-w-0 truncate font-mono text-sm text-muted-foreground">
            {target}
          </span>
        )}
        <button
          type="button"
          className="ml-auto shrink-0 text-sm text-ink-subtle underline decoration-border underline-offset-2 hover:text-run hover:decoration-run"
          onClick={() => revealToolCall(entry.toolUseId)}
        >
          Show in transcript
        </button>
      </div>
      {summary.text && (
        <p className={cn("m-0 mt-0.5 font-mono text-sm", summary.tone)}>
          {summary.text}
        </p>
      )}
      {(plot !== null || pullRequests.length > 0 || worthQuoting) && (
        <div className="mt-1.5 text-muted-foreground">
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
