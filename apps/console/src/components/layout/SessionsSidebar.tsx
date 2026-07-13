import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import type { SessionMeta } from "@nightwatch/shared";
import { ICON_UI } from "@/lib/iconProps";

import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
} from "@/components/ui/sidebar";
import { ConfirmDialog } from "@/components/layout/ConfirmDialog";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/api/client";

export function SessionsSidebar(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const activeSessionId = params.id ?? null;
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

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

  function handleDelete(sessionId: string): void {
    setConfirmingId(sessionId);
  }

  return (
    <>
      <SidebarMenu className="gap-0.5">
        {!isLoading && sessions.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            Your sessions will show up here.
          </p>
        )}
        {sessions.map((session) => (
          <SidebarMenuItem key={session.sessionId}>
            <SidebarMenuButton
              // Reserve the trash-button gutter only while it's revealed
              // (hover/focus); at rest the title uses the full width. Needs
              // `!` to beat the variant's always-on pr-8 (Tailwind sorts pr-8
              // last within the same group-has variant, so a plain override loses).
              className="pr-2! group-hover/menu-item:pr-8! group-focus-within/menu-item:pr-8!"
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
              onClick={() => handleDelete(session.sessionId)}
            >
              <Trash2 {...ICON_UI} />
            </SidebarMenuAction>
          </SidebarMenuItem>
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
