import { Outlet, useNavigate } from "@tanstack/react-router";
import { Button, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import type { RunnerRecord, SessionMeta, WsEnvelope } from "@nightwatch/shared";
import { useConsoleWs } from "../hooks/useConsoleWs.js";
import { timeAgo } from "../time.js";
import { ChatInput } from "./ChatInput.js";

type SessionStatus =
  | "streaming"
  | "awaiting-approval"
  | "concluded"
  | "escalated";

interface SidebarSession extends SessionMeta {
  status: SessionStatus;
}

function updateOrAppend(
  prev: SidebarSession[],
  sessionId: string,
  status: SessionStatus,
): SidebarSession[] {
  if (prev.some((s) => s.sessionId === sessionId)) {
    return prev.map((s) => (s.sessionId === sessionId ? { ...s, status } : s));
  }
  return [
    ...prev,
    {
      sessionId,
      token: "",
      trigger: "alert",
      title: `Session ${sessionId.slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      status,
    },
  ];
}

const STATUS_COLORS: Record<SessionStatus, string> = {
  streaming: "var(--nw-status-streaming)",
  "awaiting-approval": "var(--nw-status-awaiting)",
  concluded: "var(--nw-status-concluded)",
  escalated: "var(--nw-status-escalated)",
};

function StatusBadge({ status }: { status: SessionStatus }): React.JSX.Element {
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: "var(--nw-mono)",
        color: STATUS_COLORS[status],
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {status}
    </span>
  );
}

export function SessionsSidebar(): React.JSX.Element {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SidebarSession[]>([]);

  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () =>
      fetch("/api/runners").then((r) => {
        if (!r.ok) throw new Error(`runners ${r.status}`);
        return r.json() as Promise<RunnerRecord[]>;
      }),
  });

  const token = runners?.[0]?.token;

  const { data: fetchedSessions } = useQuery<SessionMeta[]>({
    queryKey: ["sessions", token],
    queryFn: () =>
      fetch(`/api/sessions?token=${token}`).then((r) => {
        if (!r.ok) throw new Error(`sessions ${r.status}`);
        return r.json() as Promise<SessionMeta[]>;
      }),
    enabled: !!token,
  });

  useEffect(() => {
    if (fetchedSessions) {
      setSessions(
        fetchedSessions.map((s) => ({
          ...s,
          status: "concluded" as SessionStatus,
        })),
      );
    }
  }, [fetchedSessions]);

  const handleEnvelope = useCallback((env: WsEnvelope) => {
    if (env.type === "session_delta") {
      const { sessionId } = env.payload as { sessionId: string };
      setSessions((prev) => updateOrAppend(prev, sessionId, "streaming"));
    } else if (env.type === "session_message") {
      const { sessionId } = env.payload as { sessionId: string };
      setSessions((prev) => updateOrAppend(prev, sessionId, "concluded"));
    } else if (env.type === "tool_call") {
      const { sessionId, awaitingApproval } = env.payload as {
        sessionId: string;
        awaitingApproval?: boolean;
      };
      if (awaitingApproval) {
        setSessions((prev) =>
          updateOrAppend(prev, sessionId, "awaiting-approval"),
        );
      }
    }
  }, []);

  useConsoleWs(handleEnvelope);

  return (
    <div
      style={{
        width: 260,
        height: "100vh",
        borderRight: "1px solid var(--mantine-color-dark-4)",
        display: "flex",
        flexDirection: "column",
        padding: "var(--mantine-spacing-sm)",
      }}
    >
      <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb="sm">
        Sessions
      </Text>
      <Button
        fullWidth
        size="xs"
        mb="sm"
        onClick={() => void navigate({ to: "/sessions/new" })}
      >
        New Session
      </Button>

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
              onClick={() =>
                void navigate({
                  to: "/sessions/$id",
                  params: { id: session.sessionId },
                })
              }
              style={{
                width: "100%",
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "var(--mantine-spacing-xs)",
                borderRadius: "var(--mantine-radius-sm)",
                textAlign: "left",
                color: "inherit",
              }}
            >
              <Text size="sm" truncate>
                {session.title}
              </Text>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: 2,
                }}
              >
                <StatusBadge status={session.status} />
                <Text size="xs" c="dimmed" ff="monospace">
                  {timeAgo(session.createdAt)}
                </Text>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SessionsLayout(): React.JSX.Element {
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <SessionsSidebar />
      <main style={{ flex: 1, overflow: "hidden" }}>
        <Outlet />
      </main>
    </div>
  );
}

export function SessionsEmpty(): React.JSX.Element {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text c="dimmed" size="sm">
        Select a session or start a new one
      </Text>
    </div>
  );
}

export function NewSessionPage(): React.JSX.Element {
  const { data: runners } = useQuery<RunnerRecord[]>({
    queryKey: ["runners"],
    queryFn: () =>
      fetch("/api/runners").then((r) => {
        if (!r.ok) throw new Error(`runners ${r.status}`);
        return r.json() as Promise<RunnerRecord[]>;
      }),
  });

  const token = runners?.[0]?.token ?? "";

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
      }}
    >
      <ChatInput token={token} sessionId={null} isRunning={false} />
    </div>
  );
}
