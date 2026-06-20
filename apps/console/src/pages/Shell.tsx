import { useState, useCallback } from "react";
import { AppShell, Button, Text } from "@mantine/core";
import {
  Link,
  Outlet,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ApprovalRequest, WsEnvelope } from "@nightwatch/shared";
import { useAuth } from "../auth/AuthContext.js";
import { useConsoleWs } from "../hooks/useConsoleWs.js";
import { SessionsSidebar } from "./Sessions.js";
import { SessionView } from "./SessionTranscript.js";

function NavLink({
  to,
  label,
}: {
  to: string;
  label: string;
}): React.JSX.Element {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = pathname === to || pathname.startsWith(`${to}/`);

  return (
    <Link
      to={to}
      style={{
        display: "block",
        padding: "6px var(--mantine-spacing-xs)",
        borderRadius: "var(--mantine-radius-sm)",
        color: active ? "var(--nw-accent)" : "var(--nw-text-muted)",
        background: active ? "var(--nw-surface-raised)" : "transparent",
        fontWeight: active ? 600 : 400,
        fontSize: 13,
        textDecoration: "none",
      }}
    >
      {label}
    </Link>
  );
}

function useAttentionCount(): number {
  const { data: pending = [] } = useQuery<ApprovalRequest[]>({
    queryKey: ["sessions-pending-human-input"],
    queryFn: () =>
      fetch("/api/sessions/pending-human-input").then((r) => {
        if (!r.ok) throw new Error(`pending-human-input ${r.status}`);
        return r.json() as Promise<ApprovalRequest[]>;
      }),
  });

  const [delta, setDelta] = useState(0);

  const handleEnvelope = useCallback((envelope: WsEnvelope) => {
    if (envelope.type === "INTERRUPT") setDelta((d) => d + 1);
    if (envelope.type === "INTERRUPT_RESOLVED") setDelta((d) => d - 1);
  }, []);

  useConsoleWs(handleEnvelope);

  return Math.max(0, pending.length + delta);
}

export function Shell(): React.JSX.Element {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const params = useParams({ strict: false }) as { id?: string };
  const attentionCount = useAttentionCount();
  const { phase, logout } = useAuth();

  const isSessionArea = pathname === "/" || pathname.startsWith("/sessions/");

  return (
    <AppShell
      navbar={{ width: 260, breakpoint: 0 }}
      padding={0}
      styles={{ main: { background: "var(--nw-bg)" } }}
    >
      <AppShell.Navbar
        style={{
          background: "var(--nw-surface)",
          borderRight: "1px solid var(--nw-border)",
          display: "flex",
          flexDirection: "column",
          padding: "var(--mantine-spacing-sm)",
          gap: 2,
        }}
      >
        <Text
          size="xs"
          fw={700}
          tt="uppercase"
          c="dimmed"
          style={{ letterSpacing: "0.06em", paddingBottom: 4 }}
        >
          Nightwatch
        </Text>

        <NavLink to="/" label="Sessions" />
        <NavLink to="/runners" label="Runners" />
        <NavLink to="/settings" label="Settings" />

        {attentionCount > 0 && (
          <div
            role="status"
            aria-label="awaiting approval"
            style={{
              marginTop: "var(--mantine-spacing-xs)",
              padding: "4px var(--mantine-spacing-xs)",
              borderRadius: "var(--mantine-radius-sm)",
              background: "var(--nw-accent)",
              color: "var(--nw-bg)",
              fontSize: 12,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>{attentionCount}</span>
            <span>awaiting approval</span>
          </div>
        )}

        <div
          style={{
            borderTop: "1px solid var(--nw-border)",
            marginTop: "var(--mantine-spacing-xs)",
            paddingTop: "var(--mantine-spacing-xs)",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {isSessionArea && <SessionsSidebar />}
        </div>

        <div
          style={{
            borderTop: "1px solid var(--nw-border)",
            marginTop: "var(--mantine-spacing-xs)",
            paddingTop: "var(--mantine-spacing-xs)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {phase.kind === "authenticated" && (
            <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
              {phase.email}
            </Text>
          )}
          <Button
            size="xs"
            variant="subtle"
            style={{ alignSelf: "flex-start" }}
            onClick={() => void logout()}
          >
            Log out
          </Button>
        </div>
      </AppShell.Navbar>

      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          // Session area manages its own internal scroll; other pages (Settings,
          // Runners) need the main container to scroll normally.
          overflow: isSessionArea ? "hidden" : "auto",
        }}
      >
        {isSessionArea ? (
          <SessionView sessionId={params.id ?? null} />
        ) : (
          <Outlet />
        )}
      </AppShell.Main>
    </AppShell>
  );
}
