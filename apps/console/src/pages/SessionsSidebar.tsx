import { useNavigate, useParams } from "@tanstack/react-router";
import { Text, UnstyledButton } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { Trash2 } from "lucide-react";
import type { SessionMeta } from "@nightwatch/shared";
import { apiFetch } from "../api/client.js";
import { timeAgo } from "../utils/time.js";

const ICON_PROPS = { size: 14, strokeWidth: 1.5, "aria-hidden": true } as const;

export function SessionsSidebar(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const activeSessionId = params.id ?? null;

  const { data: sessions = [] } = useQuery<SessionMeta[]>({
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
      notifications.show({
        color: "red",
        title: "Could not delete session",
        message: err instanceof Error ? err.message : "Try again.",
      });
    },
  });

  function handleDelete(e: React.MouseEvent, sessionId: string): void {
    e.stopPropagation();
    if (!window.confirm("Delete this session?")) return;
    deleteSession.mutate(sessionId);
  }

  return (
    <ul
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        flex: 1,
        overflowY: "auto",
      }}
    >
      {sessions.map((session) => (
        <li
          key={session.sessionId}
          style={{ display: "flex", alignItems: "center" }}
        >
          <button
            className="nw-session-row"
            onClick={() =>
              void navigate({
                to: "/sessions/$id",
                params: { id: session.sessionId },
              })
            }
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              cursor: "pointer",
              padding: "var(--mantine-spacing-xs)",
              borderRadius: "var(--mantine-radius-sm)",
              textAlign: "left",
              color: "var(--nw-text)",
            }}
          >
            <Text size="sm" truncate>
              {session.title}
            </Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {timeAgo(session.createdAt)}
            </Text>
          </button>
          <UnstyledButton
            aria-label="Delete session"
            onClick={(e) => handleDelete(e, session.sessionId)}
            disabled={
              deleteSession.isPending &&
              deleteSession.variables === session.sessionId
            }
            style={{
              padding: "var(--mantine-spacing-xs)",
              color: "var(--mantine-color-dimmed)",
              display: "flex",
            }}
          >
            <Trash2 {...ICON_PROPS} />
          </UnstyledButton>
        </li>
      ))}
    </ul>
  );
}
