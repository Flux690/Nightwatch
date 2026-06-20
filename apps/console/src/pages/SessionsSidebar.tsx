import { useNavigate, useParams } from "@tanstack/react-router";
import { Text, UnstyledButton } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import type { SessionMeta } from "@nightwatch/shared";
import { timeAgo } from "../utils/time.js";

const ICON_PROPS = { size: 14, strokeWidth: 1.5, "aria-hidden": true } as const;

export function SessionsSidebar(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams({ strict: false }) as { id?: string };
  const activeSessionId = params.id ?? null;

  const { data: sessions = [] } = useQuery<SessionMeta[]>({
    queryKey: ["sessions"],
    queryFn: () =>
      fetch("/api/sessions").then((r) => {
        if (!r.ok) throw new Error(`sessions ${r.status}`);
        return r.json() as Promise<SessionMeta[]>;
      }),
  });

  async function handleDelete(
    e: React.MouseEvent,
    sessionId: string,
  ): Promise<void> {
    e.stopPropagation();
    if (!window.confirm("Delete this session?")) return;

    const res = await fetch(`/api/sessions/${sessionId}`, {
      method: "DELETE",
    });
    if (!res.ok) return;

    queryClient.setQueryData<SessionMeta[]>(["sessions"], (prev = []) =>
      prev.filter((s) => s.sessionId !== sessionId),
    );
    if (activeSessionId === sessionId) {
      void navigate({ to: "/" });
    }
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
            onClick={(e) => void handleDelete(e, session.sessionId)}
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
