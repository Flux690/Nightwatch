// From the kind its tool declares, never from guessing at the result's shape.
// Where there is nothing to draw, what the call did not find is said instead.

import type { NormalizedAlert, ResolvedEvidence } from "@nightwarden/shared";
import { cn } from "@/shared/lib/utils";
import {
  parseFileChange,
  type DiffLine,
} from "@/features/session/transcript/DiffCard";
import { parsePullRequestResult } from "@/features/session/transcript/PRCard";
import {
  parseCommandRun,
  TerminalBody,
} from "@/features/session/transcript/TerminalCard";
import { commandLineOf } from "@/features/session/transcript/toolPresentation";
import { Exception, exceptionRows } from "./Exception.js";
import { ChangesList, commitsFrom, pullRequestsFrom } from "./ChangesList.js";
import { Measurement } from "./Measurement.js";
import { plotCaption, plotFrom } from "./plot.js";
import {
  carriesSeries,
  isSevere,
  isWarning,
  logExcerpt,
  type LogExcerpt,
  readingGroups,
  scannedLines,
  stateGroups,
  type ReadingGroup,
} from "./readings.js";

// Enough to see what the edit did, and what the command said. The whole of
// either is one click away in the transcript.
const MAX_DIFF_LINES = 12;
const MAX_TERMINAL_LINES = 12;

function Readings({ groups }: { groups: ReadingGroup[] }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group, at) => (
        <div key={group.server ?? at}>
          {group.server !== null && (
            <p className="m-0 mb-1 font-mono text-sm text-ink-subtle">
              {group.server}
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

function LogBody({ excerpt }: { excerpt: LogExcerpt }): React.JSX.Element {
  return (
    <div>
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
    </div>
  );
}

function DiffBody({ lines }: { lines: DiffLine[] }): React.JSX.Element {
  return (
    <pre className="m-0 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap">
      {lines.map((line, at) => (
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
  );
}

function OpenedPullRequest({
  pr,
}: {
  pr: { url: string; number: number; draft: boolean };
}): React.JSX.Element {
  return (
    <p className="m-0 text-sm">
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className="font-medium text-ring no-underline hover:underline"
      >
        #{pr.number}
      </a>
      <span className="ml-2 text-muted-foreground">
        {pr.draft ? "draft pull request" : "pull request"}
      </span>
    </p>
  );
}

// The caption belongs to the drawing, so it may be absent without anything
// moving, which a heading above could never be.
interface Drawing {
  body: React.JSX.Element;
  of: string;
  scope: string;
}

function drawingFor(
  entry: ResolvedEvidence,
  alert: NormalizedAlert | null,
): Drawing | null {
  switch (entry.kind) {
    case "metric": {
      // A series is a shape over time; everything else a measurement carries is
      // a reading, and mixed units are never bars.
      const plot = plotFrom(entry.result, alert);
      if (plot !== null) {
        const caption = plotCaption(plot);
        return { body: <Measurement plot={plot} />, ...caption };
      }
      if (carriesSeries(entry.result)) return null;
      const groups = readingGroups(entry.result);
      return groups.length === 0
        ? null
        : { body: <Readings groups={groups} />, of: "", scope: "" };
    }
    case "logs": {
      const excerpt = logExcerpt(entry.result);
      if (excerpt === null) return null;
      const scanned = scannedLines(entry.result);
      return {
        body: <LogBody excerpt={excerpt} />,
        of: "",
        scope: [
          `${excerpt.lines.length} of ${excerpt.returned} shown`,
          scanned === null ? "" : `${scanned} lines searched`,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }
    case "diff": {
      const change = parseFileChange(entry.result);
      if (change === null) return null;
      const lines = change.hunks.flatMap((hunk) => hunk.lines);
      const added = lines.filter((line) => line.type === "added").length;
      const removed = lines.filter((line) => line.type === "removed").length;
      const over = lines.length - MAX_DIFF_LINES;
      return {
        body: <DiffBody lines={lines.slice(0, MAX_DIFF_LINES)} />,
        of: change.path,
        scope: [
          `+${added} \u2212${removed}`,
          over > 0 ? `${over} further lines in the transcript` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }
    case "change": {
      const merged = pullRequestsFrom(entry.result);
      const commits = commitsFrom(entry.result);
      if (merged.length > 0 || commits.length > 0) {
        const counted = [
          merged.length > 0 ? `${merged.length} merged` : null,
          commits.length > 0 ? `${commits.length} committed` : null,
        ].filter(Boolean);
        return {
          body: <ChangesList pullRequests={merged} commits={commits} />,
          of: "",
          scope: `${counted.join(", ")} in the window`,
        };
      }
      const opened = parsePullRequestResult(entry.result);
      return opened === null
        ? null
        : {
            body: <OpenedPullRequest pr={opened} />,
            of: "",
            scope: `${opened.action} by this investigation`,
          };
    }
    case "state": {
      const groups = stateGroups(entry.result);
      return groups.length === 0
        ? null
        : { body: <Readings groups={groups} />, of: "", scope: "" };
    }
    case "terminal": {
      const run = parseCommandRun(entry.result);
      return run === null
        ? null
        : {
            body: (
              <TerminalBody
                argv={commandLineOf(entry.input)}
                run={run}
                maxLines={MAX_TERMINAL_LINES}
              />
            ),
            of: "",
            scope: `exit ${run.exitCode}`,
          };
    }
    case "exception": {
      const rows = exceptionRows(entry.result);
      return rows.length === 0
        ? null
        : { body: <Exception rows={rows} />, of: "", scope: "" };
    }
    case "text":
      return null;
  }
}

/* A result that shows less than the tool searched has to say so: blank space
   where a drawing would be reads as nothing having happened. */
function absenceIn(entry: ResolvedEvidence): string | null {
  switch (entry.kind) {
    case "metric":
      return carriesSeries(entry.result) ? "no series matched" : null;
    case "logs": {
      const scanned = scannedLines(entry.result);
      return scanned === null ? null : `no matches in ${scanned} lines`;
    }
    case "change":
      return "nothing shipped in the window";
    default:
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
  // Named once in the sources row and never drawn again, because one call's
  // chart three times reads as three measurements.
  repeat?: boolean;
}): React.JSX.Element | null {
  if (repeat) return null;

  const drawing = drawingFor(entry, alert);

  if (drawing === null) {
    const absence = absenceIn(entry);
    return absence === null ? null : (
      <p className="m-0 mt-4 font-mono text-sm text-muted-foreground">
        {absence}
      </p>
    );
  }

  return (
    <figure className="m-0 mt-8">
      {drawing.body}
      {(drawing.of !== "" || drawing.scope !== "") && (
        <figcaption className="mt-2 flex flex-wrap justify-between gap-3 text-xs text-muted-foreground">
          <span className="min-w-0 font-mono">{drawing.of}</span>
          <span className="shrink-0">{drawing.scope}</span>
        </figcaption>
      )}
    </figure>
  );
}
