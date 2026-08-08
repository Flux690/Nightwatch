import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  MoreHorizontal,
  PanelRight,
  Trash2,
} from "lucide-react";

import { Page } from "@/components/layout/Page";
import { ChatSlot } from "@/components/layout/ChatHost";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { ReportPanel } from "@/components/report/ReportPanel";
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
   this is the one place an operator would most expect to declare it. */
export function InvestigationRecordPage(): React.JSX.Element {
  const { id } = useParams({ strict: false });
  const sessionId = id ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useSession(sessionId === "" ? null : sessionId);
  const report = useSessionReport(sessionId === "" ? null : sessionId);
  const [chatRailOpen, setChatRailOpen] = useState(true);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const title = session?.title ?? "";

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
      beside={
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
      }
      /* The stepper and the rail toggle stay: neither acts on the record's
         identity - one moves between records, the other changes the layout. */
      controls={
        <div className="ml-auto flex items-center gap-1">
          <QueueStepper sessionId={sessionId} />
          {/* Ghost lights itself on aria-expanded so a menu trigger stays lit
              while its menu is open. This one is not a trigger: expanded means
              the rail is open, which is the resting state, so the light would
              never go out. The attribute stays, the fill does not. */}
          <Button
            variant="ghost"
            size="icon"
            aria-label={chatRailOpen ? "Hide the chat" : "Show the chat"}
            aria-expanded={chatRailOpen}
            className="aria-expanded:bg-transparent hover:aria-expanded:bg-state-hover"
            onClick={() => setChatRailOpen((prev) => !prev)}
          >
            <PanelRight {...ICON_UI} />
          </Button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-y-auto [contain:layout]">
          <ReportPanel
            report={report?.report ?? null}
            decisions={report?.decisions ?? []}
            evidence={report?.evidence ?? []}
            conviction={report?.conviction ?? {}}
            alerts={session?.alerts ?? []}
          />
        </div>
        {/* Width, not presence, so it closes like the sidebar. Closed it is
            zero-wide but present, so it leaves the accessibility tree and the
            tab order too. */}
        <aside
          aria-label="Investigation chat"
          aria-hidden={!chatRailOpen}
          inert={!chatRailOpen}
          className={cn(
            "flex shrink-0 flex-col overflow-hidden border-l transition-[width,border-color] duration-(--duration-panel) ease-panel",
            // The edge says where the report stops. It fades out rather than
            // switching off, leaving no hairline.
            chatRailOpen
              ? "w-(--container-rail) border-border"
              : "w-0 border-transparent",
          )}
        >
          {/* The chat holds its own width while the panel narrows past it, so
              nothing inside ever reflows. */}
          <ChatSlot
            className={cn(
              "flex min-h-0 w-(--container-rail) flex-1 shrink-0 flex-col transition-opacity duration-(--duration-fast)",
              chatRailOpen
                ? "opacity-100 delay-(--duration-base)"
                : "opacity-0 delay-0",
            )}
          />
        </aside>
      </div>
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
