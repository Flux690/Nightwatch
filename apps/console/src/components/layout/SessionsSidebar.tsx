import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import type {
  AlertSeverity,
  SessionListRow,
  SessionRunStatus,
} from "@nightwarden/shared";
import { ICON_UI } from "@/lib/iconProps";

import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
} from "@/components/ui/sidebar";
import { StatusText, type StatusTone } from "@/components/ui/status";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { useConsoleEvents } from "@/hooks/ConsoleEventsProvider";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

// The five words, and nothing else: a stopped run earns no sixth.
const STATUS_VIEW: Record<
  SessionRunStatus,
  { label: string; tone: StatusTone } | null
> = {
  action_required: { label: "Action required", tone: "warn" },
  investigating: { label: "Investigating", tone: "run" },
  resolved: { label: "Resolved", tone: "ok" },
  inconclusive: { label: "Inconclusive", tone: "muted" },
  failed: { label: "Failed", tone: "fail" },
  stopped: null,
};

// A word earns its slot by being actionable, and this list reports work
// nobody is watching.
function statusFor(
  session: SessionListRow,
  active: boolean,
): { label: string; tone: StatusTone } | null {
  if (session.status === null) return null;
  if (active && session.status === "investigating") return null;
  return STATUS_VIEW[session.status];
}

// Only critical earns the space the word takes from the title.
function severityWord(severity: AlertSeverity | null): string | null {
  return severity === "critical" ? "Critical" : null;
}

// The API orders by activity, so this stable partition is the whole sort.
function floatAwaitingHuman(rows: SessionListRow[]): SessionListRow[] {
  return [
    ...rows.filter((r) => r.awaitingHumanInput),
    ...rows.filter((r) => !r.awaitingHumanInput),
  ];
}

function SessionRow({
  session,
  active,
  deleting,
  onOpen,
  onDelete,
}: {
  session: SessionListRow;
  active: boolean;
  deleting: boolean;
  onOpen: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const status = statusFor(session, active);
  const severity = severityWord(session.severity);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        // `!` beats the variant's always-on pr-8: reserve the gutter only
        // on hover/focus so short titles keep full width.
        className="pr-2! group-hover/menu-item:pr-8! group-focus-within/menu-item:pr-8!"
        isActive={active}
        onClick={onOpen}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {severity !== null && (
            <span className="shrink-0 text-fail">{severity}</span>
          )}
          <span
            // Remount on title change so the temp -> refined swap slides in.
            key={session.title}
            title={session.title}
            className="min-w-0 flex-1 truncate animate-in slide-in-from-left-2 fade-in duration-300"
          >
            {session.title}
          </span>
        </span>
        {status !== null && (
          <StatusText
            tone={status.tone}
            className={cn(
              "shrink-0",
              session.awaitingHumanInput && "font-semibold",
            )}
          >
            {status.label}
          </StatusText>
        )}
      </SidebarMenuButton>
      <SidebarMenuAction
        showOnHover
        aria-label="Delete session"
        disabled={deleting}
        onClick={onDelete}
      >
        <Trash2 {...ICON_UI} />
      </SidebarMenuAction>
    </SidebarMenuItem>
  );
}

export function SessionsSidebar(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const activeSessionId = params.id ?? null;
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const { data: sessions = [], isLoading } = useQuery<SessionListRow[]>({
    queryKey: ["sessions"],
    queryFn: () => apiFetch<SessionListRow[]>("/api/sessions"),
  });

  const deleteSession = useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<void>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: (_result, sessionId) => {
      queryClient.setQueryData<SessionListRow[]>(["sessions"], (prev = []) =>
        prev.filter((s) => s.sessionId !== sessionId),
      );
      if (activeSessionId === sessionId) void navigate({ to: "/" });
    },
    onError: (err) => {
      toast.show({
        title: "Could not delete session",
        message: err instanceof Error ? err.message : "Try again.",
        variant: "error",
      });
    },
  });

  useConsoleEvents((env) => {
    if (env.type === "SESSION_TITLE_UPDATED") {
      const { sessionId, title } = env.payload;
      queryClient.setQueryData<SessionListRow[]>(["sessions"], (prev = []) =>
        prev.map((s) => (s.sessionId === sessionId ? { ...s, title } : s)),
      );
      return;
    }
    // Status and headline are both server-derived, so any event that can
    // change them refetches the authoritative list.
    if (
      env.type === "REPORT_UPDATED" ||
      env.type === "RUN_FINISHED" ||
      env.type === "RUN_STOPPED" ||
      env.type === "RUN_FAILED" ||
      env.type === "HUMAN_INPUT_REQUIRED" ||
      env.type === "HUMAN_INPUT_RESOLVED"
    ) {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  });

  const rows = floatAwaitingHuman(sessions);

  return (
    <>
      <SidebarMenu className="gap-0.5">
        {!isLoading && rows.length === 0 && (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            No sessions yet
          </p>
        )}
        {rows.map((session) => (
          <SessionRow
            key={session.sessionId}
            session={session}
            active={activeSessionId === session.sessionId}
            deleting={
              deleteSession.isPending &&
              deleteSession.variables === session.sessionId
            }
            onOpen={() =>
              void navigate({
                to: "/sessions/$id",
                params: { id: session.sessionId },
              })
            }
            onDelete={() => setConfirmingId(session.sessionId)}
          />
        ))}
      </SidebarMenu>

      <ConfirmDialog
        open={confirmingId !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmingId(null);
        }}
        title="Delete this session?"
        description="The session and its transcript will be removed permanently."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (confirmingId !== null) deleteSession.mutate(confirmingId);
        }}
      />
    </>
  );
}
