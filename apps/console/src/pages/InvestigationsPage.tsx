import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Telescope } from "lucide-react";
import type { SessionListRow } from "@nightwarden/shared";

import { Page, SECTION_HEADING } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useConsoleEvents } from "@/hooks/ConsoleEventsProvider";
import {
  renameSession,
  sessionsQueryKey,
  useSessions,
} from "@/hooks/useSessions";
import { groupByStatus, STATUS_LABEL } from "@/lib/investigationQueue";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

/* Colour answers one question per hue: is a person holding this up, did the
   condition stop firing, did the run break. Everything else is ink. */
function findingTone(row: SessionListRow): string {
  if (row.awaitingHumanInput) return "text-wait";
  if (row.status === "resolved") return "text-ok";
  if (row.status === "failed") return "text-fail";
  return "text-muted-foreground";
}

/* Two lines: what happened, then what the investigation says about it. The
   severity word is the user's own and is never matched against a list, so
   a fleet labelling its alerts P1 reads exactly as one labelling them critical. */
function InvestigationRow({
  row,
  running,
}: {
  row: SessionListRow;
  running: boolean;
}): React.JSX.Element {
  return (
    <li>
      <Link
        to="/investigations/$id"
        params={{ id: row.sessionId }}
        // Depth says a row is a row, not that this one matters: the heading
        // above names the group already, and saying it twice left the list ragged.
        className="flex flex-col gap-1 rounded-lg bg-card px-3 py-3 no-underline transition-colors hover:bg-card-hover"
      >
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate font-medium">
            {row.title}
          </span>
          {row.severityLabel !== null && (
            <span className="min-w-0 shrink truncate text-sm text-ink-subtle">
              {row.severityLabel}
            </span>
          )}
          {/* When it last moved, not when it opened: on a run parked for your
              answer, that is how long it has been waiting. */}
          <span className="w-9 shrink-0 text-right text-sm tabular-nums text-ink-subtle">
            {timeAgo(row.lastActivityAt)}
          </span>
        </span>

        {(row.finding !== null || running) && (
          <span className="flex items-baseline gap-3">
            <span className={cn("min-w-0 flex-1 truncate", findingTone(row))}>
              {row.finding}
            </span>
            {/* Read from the live dispatcher, so it is not decoration: it says
                a run is moving at this moment. */}
            {running && (
              <Spinner
                aria-hidden
                role="none"
                className="size-3.5 shrink-0 self-center text-run"
              />
            )}
          </span>
        )}
      </Link>
    </li>
  );
}

/* Alerts waiting for a seat are not sessions, so not rows: no transcript, no
   finding, nothing to open. No colour either - nobody is holding this up, the
   fleet is simply at the limit the reader can raise. */
function QueueBand({ queue }: { queue: QueueState }): React.JSX.Element | null {
  if (queue.waiting === 0) return null;
  const alerts = queue.waiting === 1 ? "1 alert" : `${queue.waiting} alerts`;
  return (
    <p className="mb-6 flex items-center gap-2 text-sm">
      <Spinner aria-hidden className="size-3.5 text-run" role="none" />
      <span className="font-medium">{alerts} waiting</span>
      <span className="text-muted-foreground">
        {queue.running} of {queue.limit} investigations running
        {queue.oldestArrivedAt !== null &&
          ` · oldest waiting ${timeAgo(queue.oldestArrivedAt)}`}
      </span>
    </p>
  );
}

// Centred on the stage and left-aligned inside, so the eye lands on the icon
// and reads down rather than tracking back to a centre line for every line.
function NothingYet(): React.JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="flex max-w-form flex-col gap-4">
        <Telescope
          aria-hidden
          className="size-12 text-ink-subtle"
          strokeWidth={1.5}
        />
        <span className="flex flex-col gap-1">
          <span className="font-medium">Investigations</span>
          <span className="text-ink-subtle">
            Every investigation NightWarden has opened, grouped by what each one
            needs. One opens when an alert arrives from a connected source, or
            when you pick Investigate on the Agent page.
          </span>
        </span>
      </div>
    </div>
  );
}

interface QueueState {
  waiting: number;
  running: number;
  limit: number;
  oldestArrivedAt: string | null;
}

export function InvestigationsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const {
    sessions,
    investigationTotal,
    isLoading,
    hasMore,
    isLoadingMore,
    loadMore,
  } = useSessions("investigation");
  const [queue, setQueue] = useState<QueueState>({
    waiting: 0,
    running: 0,
    limit: 0,
    oldestArrivedAt: null,
  });

  useConsoleEvents((env) => {
    if (env.type === "QUEUE_CHANGED") {
      setQueue(env.payload);
      return;
    }
    if (env.type === "SESSION_TITLE_UPDATED") {
      const { sessionId, title } = env.payload;
      renameSession(queryClient, "investigation", sessionId, title);
      return;
    }
    // Status is server-derived, so anything that can change it refetches the
    // authoritative list rather than being patched into the cache here.
    if (
      env.type === "REPORT_UPDATED" ||
      env.type === "RUN_FINISHED" ||
      env.type === "RUN_STOPPED" ||
      env.type === "RUN_FAILED" ||
      env.type === "HUMAN_INPUT_REQUIRED" ||
      env.type === "HUMAN_INPUT_RESOLVED"
    ) {
      void queryClient.invalidateQueries({
        queryKey: sessionsQueryKey("investigation"),
      });
    }
  });

  const groups = groupByStatus(sessions);

  return (
    <Page
      crumbs={[{ label: "Investigations" }]}
      measure="page"
      /* The one true total: a group's count describes the page that happens to
         be loaded, and stops matching anything after Load older. */
      beside={
        investigationTotal > 0 ? (
          <span className="ml-2 shrink-0 text-sm tabular-nums text-ink-subtle">
            {investigationTotal}
          </span>
        ) : undefined
      }
    >
      {!isLoading && groups.length === 0 ? (
        <NothingYet />
      ) : (
        <>
          <QueueBand queue={queue} />
          {/* Space separates the groups; there is no rule and no column header. */}
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section
                key={group.status}
                aria-label={STATUS_LABEL[group.status]}
              >
                {/* An eyebrow, not a filled band: the band's fill was the value
                    a row hovers to, so it read as a row under the cursor. */}
                <h2 className={`${SECTION_HEADING} mb-2 px-3`}>
                  {STATUS_LABEL[group.status]}
                </h2>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {group.rows.map((row) => (
                    <InvestigationRow
                      key={row.sessionId}
                      row={row}
                      running={group.status === "investigating"}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {hasMore && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-6 self-start text-muted-foreground"
              disabled={isLoadingMore}
              onClick={loadMore}
            >
              {isLoadingMore ? "Loading…" : "Load older investigations"}
            </Button>
          )}
        </>
      )}
    </Page>
  );
}
