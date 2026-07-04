import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import type { SessionMeta } from "@nightwatch/shared";

import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
} from "@/components/ui/sidebar";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

export function SessionsSidebar(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const activeSessionId = params.id ?? null;

  const { data: sessions = [], isLoading } = useQuery<SessionMeta[]>({
    queryKey: ["sessions"],
    queryFn: () => apiFetch<SessionMeta[]>("/api/sessions"),
  });

  const deleteSession = useMutation({
    mutationFn: (sessionId: string) =>
      apiFetch<void>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: (_result, sessionId) => {
      queryClient.setQueryData<SessionMeta[]>(["sessions"], (prev = []) =>
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

  function handleDelete(e: React.MouseEvent, sessionId: string): void {
    e.stopPropagation();
    if (!window.confirm("Delete this session?")) return;
    deleteSession.mutate(sessionId);
  }

  return (
    <SidebarMenu className="gap-0.5 overflow-y-auto">
      {!isLoading && sessions.length === 0 && (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          Your sessions will show up here.
        </p>
      )}
      {sessions.map((session) => (
        <SidebarMenuItem key={session.sessionId}>
          <SidebarMenuButton
            isActive={activeSessionId === session.sessionId}
            onClick={() =>
              void navigate({
                to: "/sessions/$id",
                params: { id: session.sessionId },
              })
            }
          >
            <span title={session.title}>{session.title}</span>
          </SidebarMenuButton>
          <SidebarMenuAction
            showOnHover
            aria-label="Delete session"
            disabled={
              deleteSession.isPending &&
              deleteSession.variables === session.sessionId
            }
            onClick={(e: React.MouseEvent) =>
              handleDelete(e, session.sessionId)
            }
          >
            <Trash2 />
          </SidebarMenuAction>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
