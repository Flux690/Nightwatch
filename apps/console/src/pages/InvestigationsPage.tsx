import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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

/* One line: the symptom that fired, what the investigation has to say about it,
   then the two right-aligned facts. Nothing at rest, so the row the cursor is
   on is the only lit thing on the page, and it lights to the header's own fill. */
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
        className="flex items-center gap-3 rounded-lg px-3 py-2 no-underline transition-colors hover:bg-card"
      >
        {/* The finding is the flexible one: it takes the slack the title leaves
            and gives every pixel of it back before the title is cut short. */}
        <span className="min-w-0 truncate font-medium">{row.title}</span>
        {row.finding !== null && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {row.finding}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-3 text-muted-foreground">
          {/* This group is derived from the live dispatcher, so the spinner is
              not decoration: it says a run is moving at this moment. Hidden from
              the accessibility tree because the group heading above already
              says it, and repeating it on every row says nothing new. */}
          {running && <Spinner aria-hidden className="size-3.5" role="none" />}
          {row.severityLabel !== null && <span>{row.severityLabel}</span>}
          <span className="tabular-nums">{timeAgo(row.createdAt)}</span>
        </span>
      </Link>
    </li>
  );
}

/* Alerts waiting for a free seat are not sessions, so they are not rows: they
   have no transcript, no finding and nothing to open. A band says how many are
   waiting and why, and names the limit - which is the one thing the reader can
   change about it. */
function QueueBand({ queue }: { queue: QueueState }): React.JSX.Element | null {
  if (queue.waiting === 0) return null;
  const alerts = queue.waiting === 1 ? "1 alert" : `${queue.waiting} alerts`;
  return (
    <p className="mb-4 flex h-7 items-center gap-2 rounded-lg bg-card px-3 text-sm">
      <Spinner aria-hidden className="size-3.5" role="none" />
      <span className="font-medium">{alerts} waiting</span>
      <span className="text-muted-foreground">
        {queue.running} of {queue.limit} investigations running
        {queue.oldestArrivedAt !== null &&
          ` · oldest waiting ${timeAgo(queue.oldestArrivedAt)}`}
      </span>
    </p>
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
  const { sessions, isLoading, hasMore, isLoadingMore, loadMore } =
    useSessions("investigation");
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
    <Page crumbs={[{ label: "Investigations" }]} measure="full">
      <QueueBand queue={queue} />
      {!isLoading && groups.length === 0 && (
        <p className="text-sm text-muted-foreground">No investigations yet</p>
      )}
      {/* Space separates the groups; there is no rule and no column header. */}
      <div className="flex flex-col gap-6">
        {groups.map((group) => (
          <section key={group.status} aria-label={STATUS_LABEL[group.status]}>
            {/* A band, kept shallow: it separates the group without competing
                with the rows, and a row lights to this same fill on hover. */}
            <h2
              className={`${SECTION_HEADING} mb-1 flex h-7 items-center rounded-lg bg-card px-3`}
            >
              {STATUS_LABEL[group.status]}
            </h2>
            <ul className="m-0 flex list-none flex-col p-0">
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
    </Page>
  );
}
