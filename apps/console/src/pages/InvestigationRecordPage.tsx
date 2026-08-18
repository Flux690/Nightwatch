import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelRight,
  Trash2,
} from "lucide-react";

import { Page } from "@/components/layout/Page";
import { ChatRail } from "@/components/layout/ChatRail";
import { SessionView } from "@/pages/SessionView";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { ReportPanel } from "@/components/report/ReportPanel";
import { onOpenReport } from "@/components/transcript/openReport";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/hooks/useSession";
import { useSessionReport } from "@/hooks/useSessionReport";
import { removeSession, useSessions } from "@/hooks/useSessions";
import { investigationQueue } from "@/lib/investigationQueue";
import { ICON_UI } from "@/lib/iconProps";
import { reportToMarkdown } from "@/lib/reportMarkdown";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/api/client";

/* The record's place in the queue, so triage moves record to record without
   returning to the list and finding the row again. The order is the list's own
   and the total is the server's, so the two can never disagree. */
function QueueStepper({
  sessionId,
}: {
  sessionId: string;
}): React.JSX.Element | null {
  const navigate = useNavigate();
  const { sessions, investigationTotal } = useSessions("investigation");
  const queue = investigationQueue(sessions);
  const at = queue.findIndex((row) => row.sessionId === sessionId);
  // A session the list has not placed yet - a promotion a moment ago - claims
  // no position rather than a wrong one.
  if (at === -1) return null;

  const step = (to: number): void => {
    const target = queue[to];
    if (target !== undefined) {
      void navigate({
        to: "/investigations/$id",
        params: { id: target.sessionId },
      });
    }
  };

  return (
    <>
      <span className="text-sm tabular-nums text-muted-foreground">
        {at + 1} / {investigationTotal}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Previous investigation"
        disabled={at === 0}
        onClick={() => step(at - 1)}
      >
        <ChevronLeft {...ICON_UI} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Next investigation"
        disabled={at >= queue.length - 1}
        onClick={() => step(at + 1)}
      >
        <ChevronRight {...ICON_UI} />
      </Button>
    </>
  );
}

/* The report with its chat rail, headed by a breadcrumb back to the list. No
   "Mark as resolved" in the menu: status is derived and never declared, and
   this is the one place a user would most expect to declare it. */
export function InvestigationRecordPage(): React.JSX.Element {
  const { id } = useParams({ strict: false });
  const sessionId = id ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useSession(sessionId === "" ? null : sessionId);
  const report = useSessionReport(sessionId === "" ? null : sessionId);
  const [chatRailOpen, setChatRailOpen] = useState(true);
  const [chatExpanded, setChatExpanded] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const title = session?.title ?? "";

  /* A count rather than a flag: the card is still clickable once the report is
     already the view, where the swap is a no-op and re-aiming is the answer. */
  const [openRequests, setOpenRequests] = useState(0);
  /* Latched at the first load and never re-read: the run ending must not move the
     reader. Set during render rather than from an effect, so the first painted
     frame is already the right one. */
  const followedRun = useRef<boolean | null>(null);
  if (followedRun.current === null && session !== null) {
    followedRun.current = session.running;
  }
  useEffect(
    () => onOpenReport(() => setOpenRequests((asked) => asked + 1)),
    [],
  );

  // Unknown reads as the record, which is what the page showed before there was
  // anything to follow, so a session still loading never flashes the transcript.
  const working = followedRun.current === true && openRequests === 0;

  // In an effect rather than the handler, so the first request finds the column
  // the render it triggered has just mounted.
  const reportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openRequests === 0) return;
    const column = reportRef.current;
    if (column === null) return;
    column.scrollTop = 0;
    column.focus();
  }, [openRequests]);

  const remove = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: () => {
      removeSession(queryClient, "investigation", sessionId);
      void navigate({ to: "/investigations" });
    },
    onError: (err) => {
      toast.show({
        title: "Could not delete investigation",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  const copyMarkdown = (): void => {
    void navigator.clipboard
      .writeText(reportToMarkdown(title, session?.alerts ?? [], report ?? null))
      .then(() => toast.show({ message: "Report copied as Markdown" }))
      .catch(() =>
        toast.show({ message: "Could not copy the report", variant: "error" }),
      );
  };

  return (
    <Page
      crumbs={[
        { label: "Investigations", to: "/investigations" },
        { label: title },
      ]}
      measure="none"
      /* The menu acts on the investigation, so it sits after its name rather
         than at the far edge: the crumb truncates at its own ceiling and the
         menu follows wherever the name ends, sliding left for a short title. */
      /* One bar, so the rail's edge runs the full height of the stage. The menu
         sits against the name because it acts on the record; the stepper and the
         rail toggle are right-aligned because they do not. */
      beside={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="More actions"
                  className="ml-1 shrink-0 rounded-full text-muted-foreground"
                >
                  <MoreHorizontal {...ICON_UI} />
                </Button>
              }
            />
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={copyMarkdown}>
                <ClipboardCopy {...ICON_UI} />
                Copy report as Markdown
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setConfirmingDelete(true)}>
                <Trash2 {...ICON_UI} />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <QueueStepper sessionId={sessionId} />
            {/* The stepper moves between records and this pair changes the shape
                of the one on screen, so a gap separates them rather than reading
                as a third stepper button. It cannot sit in the rail: closed, the
                rail is zero wide and has nothing to click. */}
            {!working && chatRailOpen && (
              <Button
                variant="ghost"
                size="icon"
                className="ml-3"
                aria-label={
                  chatExpanded ? "Shrink the chat" : "Expand the chat"
                }
                onClick={() => setChatExpanded((prev) => !prev)}
              >
                {chatExpanded ? (
                  <Minimize2 {...ICON_UI} />
                ) : (
                  <Maximize2 {...ICON_UI} />
                )}
              </Button>
            )}
            {/* Ghost lights itself on aria-expanded so a menu trigger stays lit
                while its menu is open. This one is not a trigger: expanded means
                the rail is open, which is the resting state, so the light would
                never go out. The attribute stays, the fill does not. */}
            {!working && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={chatRailOpen ? "Hide the chat" : "Show the chat"}
                aria-expanded={chatRailOpen}
                className={cn(
                  "aria-expanded:bg-transparent hover:aria-expanded:bg-state-hover",
                  !chatRailOpen && "ml-3",
                )}
                onClick={() => {
                  // Closing leaves expanded behind with it: a rail that is not on
                  // screen cannot be in a mode.
                  setChatRailOpen((prev) => !prev);
                  setChatExpanded(false);
                }}
              >
                <PanelRight {...ICON_UI} />
              </Button>
            )}
          </div>
        </>
      }
    >
      {working ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:stage-fall">
          <SessionView sessionId={sessionId === "" ? null : sessionId} />
        </div>
      ) : (
        /* Positioned, so the expanded rail covers the report rather than pushing
           it out. The report stays mounted underneath and comes back unscrolled. */
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div
            ref={reportRef}
            tabIndex={-1}
            className="min-w-0 flex-1 overflow-y-auto [contain:layout]"
          >
            <ReportPanel
              report={report?.report ?? null}
              decisions={report?.decisions ?? []}
              evidence={report?.evidence ?? []}
              conviction={report?.conviction ?? {}}
              alerts={session?.alerts ?? []}
            />
          </div>
          <ChatRail
            sessionId={sessionId === "" ? null : sessionId}
            open={chatRailOpen}
            expanded={chatExpanded}
          />
        </div>
      )}
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false);
        }}
        title="Delete this investigation?"
        description={`"${title}" and its transcript will be removed permanently.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => remove.mutate()}
      />
    </Page>
  );
}
