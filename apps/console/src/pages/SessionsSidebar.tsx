import { useRef, useState } from "react";
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

  const { data: sessions = [], isLoading } = useQuery<SessionMeta[]>({
    queryKey: ["sessions"],
    queryFn: () => apiFetch<SessionMeta[]>("/api/sessions"),
  });

  const [roveIndex, setRoveIndex] = useState(0);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeRoveIndex = Math.min(roveIndex, Math.max(sessions.length - 1, 0));

  function handleRowKeyDown(e: React.KeyboardEvent, index: number): void {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const nextIndex =
      e.key === "ArrowDown"
        ? Math.min(index + 1, sessions.length - 1)
        : Math.max(index - 1, 0);
    setRoveIndex(nextIndex);
    rowRefs.current[nextIndex]?.focus();
  }

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
      {!isLoading && sessions.length === 0 && (
        <Text size="xs" c="dimmed" p="xs" component="li">
          Your sessions will show up here.
        </Text>
      )}
      {sessions.map((session, index) => (
        <li
          key={session.sessionId}
          style={{ display: "flex", alignItems: "center" }}
        >
          <button
            ref={(el) => {
              rowRefs.current[index] = el;
            }}
            className="session-row"
            data-active={
              activeSessionId === session.sessionId ? "true" : undefined
            }
            tabIndex={index === activeRoveIndex ? 0 : -1}
            onKeyDown={(e) => handleRowKeyDown(e, index)}
            onFocus={() => setRoveIndex(index)}
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
              color: "var(--color-ink)",
            }}
          >
            <Text size="sm" truncate title={session.title}>
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
