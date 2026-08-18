import type {
  EvidenceKind,
  NormalizedAlert,
  ResolvedEvidence,
} from "@nightwarden/shared";
import { cn } from "@/lib/utils";
import { revealToolCall } from "@/components/transcript/revealToolCall";
import { Button } from "@/components/ui/button";
import {
  resultSummary,
  targetOf,
} from "@/components/transcript/toolPresentation";
import { parseFileChange } from "@/components/transcript/DiffCard";
import { parsePullRequestResult } from "@/components/transcript/PRCard";
import { ChangesList, pullRequestsFrom } from "./ChangesList.js";
import { Measurement } from "./Measurement.js";
import { plotFrom } from "./plot.js";
import {
  carriesSeries,
  isSevere,
  isWarning,
  logExcerpt,
  readingGroups,
  scannedLines,
  stateGroups,
  type ReadingGroup,
} from "./readings.js";

/* What a cited call is drawn as comes from the kind its tool declares, never
   from guessing at the result's shape. A kind that finds nothing it can draw
   renders nothing, and the one-line reading above stands as the whole answer. */

// Enough to see what the edit did. The whole change is one click away, and the
// report is not where a file is reviewed.
const MAX_DIFF_LINES = 12;

function Readings({ groups }: { groups: ReadingGroup[] }): React.JSX.Element {
  return (
    <div className="mt-2 flex flex-col gap-3">
      {groups.map((group, at) => (
        <div key={group.runner ?? at}>
          {group.runner !== null && (
            <p className="m-0 mb-1 font-mono text-sm text-ink-subtle">
              {group.runner}
            </p>
          )}
          <dl className="m-0 flex flex-col gap-1">
            {group.rows.map((row) => (
              <div key={row.key} className="flex gap-3">
                <dt className="w-40 shrink-0 text-sm text-ink-subtle">
                  {row.label}
                </dt>
                <dd className="m-0 min-w-0 font-mono text-sm tabular-nums break-words">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

function lineTone(line: string): string {
  if (isSevere(line)) return "text-fail";
  return isWarning(line) ? "text-wait" : "text-muted-foreground";
}

function LogBody({ result }: { result: string }): React.JSX.Element | null {
  const excerpt = logExcerpt(result);
  if (excerpt === null) return null;
  const scanned = scannedLines(result);

  return (
    <div className="mt-2">
      <pre className="m-0 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap">
        {excerpt.worstAbove !== null && (
          <>
            <span className={lineTone(excerpt.worstAbove)}>
              {excerpt.worstAbove}
            </span>
            {"\n"}
            <span className="text-ink-subtle">{"⋮"}</span>
            {"\n"}
          </>
        )}
        {excerpt.lines.map((line, at) => (
          <span key={at} className={cn("block", lineTone(line))}>
            {line}
          </span>
        ))}
      </pre>
      {/* What the excerpt cannot speak for: how much was read, and how much of
          it is on screen. */}
      <p className="m-0 mt-2 text-sm text-ink-subtle">
        {excerpt.lines.length} of {excerpt.returned} shown
        {scanned !== null && `, ${scanned} lines searched`}
      </p>
    </div>
  );
}

function DiffBody({ result }: { result: string }): React.JSX.Element | null {
  const change = parseFileChange(result);
  if (change === null) return null;
  const lines = change.hunks.flatMap((hunk) => hunk.lines);
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const added = lines.filter((line) => line.type === "added").length;
  const removed = lines.filter((line) => line.type === "removed").length;

  return (
    <div className="mt-2">
      <p className="m-0 mb-1 font-mono text-sm">
        <span className="text-muted-foreground">{change.path}</span>
        <span className="ml-2 text-ok">+{added}</span>
        <span className="ml-1 text-fail">-{removed}</span>
      </p>
      <pre className="m-0 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap">
        {shown.map((line, at) => (
          <span
            key={at}
            className={cn(
              "block",
              line.type === "added" && "text-ok",
              line.type === "removed" && "text-fail",
              line.type === "unchanged" && "text-muted-foreground",
            )}
          >
            {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
            {line.content}
          </span>
        ))}
      </pre>
      {lines.length > shown.length && (
        <p className="m-0 mt-2 text-sm text-ink-subtle">
          {lines.length - shown.length} further lines in the transcript
        </p>
      )}
    </div>
  );
}

function ChangeBody({ result }: { result: string }): React.JSX.Element | null {
  const merged = pullRequestsFrom(result);
  if (merged.length > 0) return <ChangesList pullRequests={merged} />;

  // The pull request this run opened, which is a change like any other.
  const opened = parsePullRequestResult(result);
  if (opened === null) return null;
  return (
    <p className="m-0 mt-2 text-sm">
      <a
        href={opened.url}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-ring no-underline hover:underline"
      >
        #{opened.number}
      </a>
      <span className="ml-2 text-muted-foreground">
        {opened.draft ? "draft pull request" : "pull request"} {opened.action}
      </span>
    </p>
  );
}

/* A plain function rather than a component, so the caller can tell a kind that
   drew something from one that did not: the one-line reading is what stands in
   when nothing is drawn, and printing both says the same thing twice. */
function bodyFor(
  kind: EvidenceKind,
  entry: ResolvedEvidence,
  alert: NormalizedAlert | null,
): React.JSX.Element | null {
  switch (kind) {
    case "metric": {
      // A series is a shape over time; everything else a measurement carries is
      // a reading, and mixed units are never bars.
      const plot = plotFrom(entry.result, alert);
      if (plot !== null) return <Measurement plot={plot} />;
      if (carriesSeries(entry.result)) return null;
      const groups = readingGroups(entry.result);
      return groups.length === 0 ? null : <Readings groups={groups} />;
    }
    case "logs":
      return <LogBody result={entry.result} />;
    case "diff":
      return <DiffBody result={entry.result} />;
    case "change":
      return <ChangeBody result={entry.result} />;
    case "state": {
      const groups = stateGroups(entry.result);
      return groups.length === 0 ? null : <Readings groups={groups} />;
    }
    case "text":
      return null;
  }
}

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
  // A call that answered nothing has nothing to draw: its outcome is the whole
  // reading, and it is what the line below carries.
  const body =
    entry.outcome === undefined ? bodyFor(entry.kind, entry, alert) : null;

  return (
    <div className="mt-2 border-l border-border pl-3">
      {header}
      {body === null && summary.text !== "" && (
        <p className={cn("m-0 mt-1 font-mono text-sm", summary.tone)}>
          {summary.text}
        </p>
      )}
      {body}
    </div>
  );
}
