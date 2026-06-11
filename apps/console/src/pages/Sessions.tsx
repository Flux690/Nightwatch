import { useNavigate } from "@tanstack/react-router";
import { Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import type { RunnerRecord, SessionMeta } from "@nightwatch/shared";
import { timeAgo } from "../time.js";

export function SessionsSidebar(): React.JSX.Element {
  const navigate = useNavigate();

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () =>
      fetch("/api/runners").then((r) => {
        if (!r.ok) throw new Error(`runners ${r.status}`);
        return r.json() as Promise<RunnerRecord[]>;
      }),
  });

  const token = runners?.[0]?.token;

  const { data: sessions = [] } = useQuery<SessionMeta[]>({
    queryKey: ["sessions", token],
    queryFn: () =>
      fetch(`/api/sessions?token=${token}`).then((r) => {
        if (!r.ok) throw new Error(`sessions ${r.status}`);
        return r.json() as Promise<SessionMeta[]>;
      }),
    enabled: !!token,
  });

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
        <li key={session.sessionId}>
          <button
            className="nw-session-row"
            onClick={() =>
              void navigate({
                to: "/sessions/$id",
                params: { id: session.sessionId },
              })
            }
            style={{
              width: "100%",
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
        </li>
      ))}
    </ul>
  );
}
