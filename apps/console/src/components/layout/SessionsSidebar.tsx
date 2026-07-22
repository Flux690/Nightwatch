import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import type {
  AlertSeverity,
  SessionListRow,
  SessionRunStatus,
} from "@nightwatch/shared";
import { ICON_UI } from "@/lib/iconProps";

import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
} from "@/components/ui/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { useConsoleEvents } from "@/hooks/ConsoleEventsProvider";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

type Tab = "investigations" | "conversations";

// Flat list, statuses not groups: state is a chip on the row, and the one
// sort exception is that a paused agent floats to the top - it is waiting
// on a human and must never be buried under newer resolved rows.
const STATUS_CHIP: Record<
  SessionRunStatus,
  { label: string; className: string }
> = {
  action_required: {
    label: "Action required",
    className: "bg-wait-tint text-wait",
  },
  investigating: {
    label: "Investigating",
    className: "bg-run-tint text-run animate-pulse",
  },
  resolved: { label: "Resolved", className: "bg-ok-tint text-ok" },
  inconclusive: {
    label: "Inconclusive",
    className: "bg-surface text-muted-foreground",
  },
  failed: { label: "Failed", className: "bg-fail-tint text-fail" },
  stopped: { label: "Stopped", className: "bg-surface text-muted-foreground" },
};

const SEVERITY_DOT: Record<AlertSeverity, string> = {
  critical: "bg-fail",
  warning: "bg-wait",
  info: "bg-border-strong",
};

function floatActionRequired(rows: SessionListRow[]): SessionListRow[] {
  return [
    ...rows.filter((r) => r.status === "action_required"),
    ...rows.filter((r) => r.status !== "action_required"),
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
  const chip = session.status !== null ? STATUS_CHIP[session.status] : null;
  const subline = session.investigation
    ? (session.rootCauseLine ?? session.target ?? "started by you")
    : null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        // `!` beats the variant's always-on pr-8: reserve the gutter only
        // on hover/focus so short titles keep full width.
        className="h-auto flex-col items-start gap-1 py-2 pr-2! group-hover/menu-item:pr-8! group-focus-within/menu-item:pr-8!"
        isActive={active}
        onClick={onOpen}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          {session.severity !== null && (
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-full",
                SEVERITY_DOT[session.severity],
              )}
            />
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
        {(subline !== null || chip !== null) && (
          <span className="flex w-full min-w-0 items-center gap-2">
            {subline !== null && (
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {subline}
              </span>
            )}
            {chip !== null && (
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold",
                  chip.className,
                )}
              >
                {chip.label}
              </span>
            )}
          </span>
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
  const [tab, setTab] = useState<Tab>("investigations");

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
    // Status, headline and tab membership are all server-derived, so any
    // event that can change them refetches the authoritative list.
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

  // Rows predating the queue fields count as conversations.
  const investigations = floatActionRequired(
    sessions.filter((s) => s.investigation === true),
  );
  const conversations = sessions.filter((s) => s.investigation !== true);
  const rows = tab === "investigations" ? investigations : conversations;

  return (
    <>
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        className="mb-2 px-1"
      >
        <TabsList className="w-full">
          <TabsTrigger value="investigations" className="flex-1">
            Investigations
          </TabsTrigger>
          <TabsTrigger value="conversations" className="flex-1">
            Conversations
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <SidebarMenu className="gap-0.5">
        {!isLoading && rows.length === 0 && (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {tab === "investigations"
              ? "Investigations appear when an alert fires or you escalate a chat."
              : "No conversations yet - start one from New session."}
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
