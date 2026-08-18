import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ChevronDown,
  ClipboardCopy,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";

import { Page } from "@/components/layout/Page";
import { SessionView } from "@/pages/SessionView";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useSession } from "@/hooks/useSession";
import { removeSession, useSessions } from "@/hooks/useSessions";
import { chatToMarkdown } from "@/lib/chatMarkdown";
import { ICON_UI } from "@/lib/iconProps";
import { DAY_GROUPS, dayGroup, timeAgo } from "@/lib/time";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

/* Only conversations a person started. An alert-opened session was never one,
   and the kind filter is the whole of that rule: a session is what it is from
   the moment it exists, so no row ever leaves this list. */
function ChatHistory({ onLeave }: { onLeave: () => void }): React.JSX.Element {
  const { sessions, isLoading, hasMore, isLoadingMore, loadMore } =
    useSessions("chat");

  const groups = DAY_GROUPS.map((group) => ({
    group,
    rows: sessions.filter((row) => dayGroup(row.lastActivityAt) === group),
  })).filter((entry) => entry.rows.length > 0);

  return (
    <>
      {!isLoading && groups.length === 0 && (
        <p className="m-0 px-2.5 py-1 text-sm text-muted-foreground">
          No history
        </p>
      )}
      {groups.map(({ group, rows }, index) => (
        <section key={group} aria-label={group} className="flex flex-col">
          {/* Every division in this panel is drawn the same way and spaced the
              same, so the New chat entry and one day against the next read as
              one rhythm rather than two. */}
          {index > 0 && <Separator className="my-1 bg-border-overlay" />}
          {/* A day, written the way it is said. The uppercase mono label is for
              naming a system's own parts, which a Tuesday is not. */}
          <h3 className="m-0 px-2.5 py-1 text-sm font-normal text-muted-foreground">
            {group}
          </h3>
          <ul className="m-0 flex list-none flex-col p-0">
            {rows.map((row) => (
              <li key={row.sessionId}>
                <Link
                  to="/agent/$id"
                  params={{ id: row.sessionId }}
                  onClick={onLeave}
                  className="flex items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm no-underline transition-colors hover:bg-state-hover"
                >
                  <span className="min-w-0 truncate">{row.title}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {timeAgo(row.lastActivityAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-muted-foreground"
          disabled={isLoadingMore}
          onClick={loadMore}
        >
          {isLoadingMore ? "Loading…" : "Load older conversations"}
        </Button>
      )}
    </>
  );
}

/* The conversation runs the full stage, so this page has no measured body and
   no controls row. Everything it offers rides the crumb: the history it belongs
   to, and the two things you can do to the one you are in. */
export function AgentPage(): React.JSX.Element {
  const { id } = useParams({ strict: false });
  const sessionId = id ?? null;
  const session = useSession(sessionId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const title = session?.title ?? "New chat";

  const remove = useMutation({
    mutationFn: () =>
      apiFetch<void>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: () => {
      if (sessionId !== null) removeSession(queryClient, "chat", sessionId);
      void navigate({ to: "/agent" });
    },
    onError: (err) => {
      toast.show({
        title: "Could not delete this chat",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  const copyMarkdown = (): void => {
    void navigator.clipboard
      .writeText(chatToMarkdown(title, session?.transcript ?? []))
      .then(() => toast.show({ message: "Chat copied as Markdown" }))
      .catch(() =>
        toast.show({ message: "Could not copy the chat", variant: "error" }),
      );
  };

  return (
    <Page
      crumbs={[]}
      measure="none"
      beside={
        <div className="flex min-w-0 items-center gap-1">
          <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
            {/* Name and chevron are one target: the disclosure is the name,
                not a control standing next to it. */}
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="max-w-title gap-1 rounded-full px-2"
                >
                  <span className="min-w-0 truncate">{title}</span>
                  <ChevronDown
                    strokeWidth={1.75}
                    aria-hidden
                    className="shrink-0 text-muted-foreground"
                  />
                </Button>
              }
            />
            {/* Under the whole disclosure, not centred on it: the panel opens
                from the name it belongs to. */}
            <PopoverContent align="start" className="gap-0">
              {/* Only once there is something to start afresh from, and above
                  the list because it is an action rather than one of its rows. */}
              {sessionId !== null && (
                <>
                  <Link
                    to="/agent"
                    onClick={() => setHistoryOpen(false)}
                    className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm no-underline transition-colors hover:bg-state-hover"
                  >
                    <Plus {...ICON_UI} />
                    New chat
                  </Link>
                  <Separator className="my-1 bg-border-overlay" />
                </>
              )}
              <ChatHistory onLeave={() => setHistoryOpen(false)} />
            </PopoverContent>
          </Popover>

          {sessionId !== null && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="More actions"
                    className="rounded-full text-muted-foreground"
                  >
                    <MoreHorizontal {...ICON_UI} />
                  </Button>
                }
              />
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={copyMarkdown}>
                  <ClipboardCopy {...ICON_UI} />
                  Copy as Markdown
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* The API refuses this while a run holds the session, so the
                    menu says so rather than offering an error. */}
                <DropdownMenuItem
                  disabled={session?.running === true}
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 {...ICON_UI} />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      }
    >
      {/* The fall belongs to this surface alone, where the conversation has the
          whole stage to fall through. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:stage-fall">
        <SessionView sessionId={sessionId} />
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false);
        }}
        title="Delete this chat?"
        description={`"${title}" and its transcript will be removed permanently.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => remove.mutate()}
      />
    </Page>
  );
}
