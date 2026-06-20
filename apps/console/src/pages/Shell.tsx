import { useState, useCallback } from "react";
import { AppShell, Tooltip, UnstyledButton, Button, Text } from "@mantine/core";
import {
  Link,
  Outlet,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Plus,
  Server,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import type { ApprovalRequest, ConsoleEvent } from "@nightwatch/shared";
import { useAuth } from "../auth/AuthContext.js";
import { useConsoleWs } from "../hooks/useConsoleWs.js";
import { SessionsSidebar } from "./Sessions.js";
import { SessionView } from "./SessionView.js";

const SIDEBAR_KEY = "nw:sidebar-expanded";
const EXPANDED_WIDTH = 250;
const COLLAPSED_WIDTH = 60;
const ICON_PROPS = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

function useSidebarExpanded(): [boolean, () => void] {
  const [expanded, setExpanded] = useState<boolean>(
    () => localStorage.getItem(SIDEBAR_KEY) !== "false",
  );

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_KEY, String(next));
      return next;
    });
  }, []);

  return [expanded, toggle];
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

  const handleEnvelope = useCallback((envelope: ConsoleEvent) => {
    if (envelope.type === "HUMAN_INPUT_REQUIRED") setDelta((d) => d + 1);
    if (envelope.type === "HUMAN_INPUT_RESOLVED") setDelta((d) => d - 1);
  }, []);

  useConsoleWs(handleEnvelope);

  return Math.max(0, pending.length + delta);
}

function NavLink({
  to,
  icon,
  label,
  compact,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  compact: boolean;
}): React.JSX.Element {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = pathname === to || pathname.startsWith(`${to}/`);

  const linkStyle = {
    display: "flex",
    alignItems: "center",
    borderRadius: "var(--mantine-radius-sm)",
    color: active ? "var(--nw-accent)" : "var(--nw-text-muted)",
    background: active ? "var(--nw-surface-raised)" : "transparent",
    textDecoration: "none",
  };

  if (compact) {
    return (
      <Tooltip label={label} position="right" withArrow>
        <Link
          to={to}
          aria-label={label}
          style={{
            ...linkStyle,
            justifyContent: "center",
            width: 40,
            height: 36,
          }}
        >
          {icon}
        </Link>
      </Tooltip>
    );
  }

  return (
    <Link
      to={to}
      style={{
        ...linkStyle,
        gap: 8,
        padding: "6px var(--mantine-spacing-xs)",
        fontWeight: active ? 600 : 400,
        fontSize: 13,
      }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

export function Shell(): React.JSX.Element {
  const [expanded, toggleExpanded] = useSidebarExpanded();
  const [sessionsOpen, setSessionsOpen] = useState(true);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const params = useParams({ strict: false }) as { id?: string };
  const attentionCount = useAttentionCount();
  const { phase, logout } = useAuth();
  const navigate = useNavigate();

  const isSessionArea = pathname === "/" || pathname.startsWith("/sessions/");
  const ownerEmail = phase.kind === "authenticated" ? phase.email : null;

  return (
    <AppShell
      navbar={{
        width: expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH,
        breakpoint: 0,
      }}
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
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: expanded ? "flex-end" : "center",
            marginBottom: 2,
          }}
        >
          <Tooltip
            label={expanded ? "Collapse sidebar" : "Expand sidebar"}
            position="right"
            withArrow
            disabled={expanded}
          >
            <UnstyledButton
              onClick={toggleExpanded}
              aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                borderRadius: "var(--mantine-radius-sm)",
                color: "var(--nw-text-muted)",
              }}
            >
              {expanded ? (
                <ChevronLeft {...ICON_PROPS} />
              ) : (
                <ChevronRight {...ICON_PROPS} />
              )}
            </UnstyledButton>
          </Tooltip>
        </div>

        {expanded ? (
          <Button
            leftSection={<Plus {...ICON_PROPS} />}
            variant="light"
            size="sm"
            fullWidth
            onClick={() => void navigate({ to: "/" })}
          >
            New session
          </Button>
        ) : (
          <Tooltip label="New session" position="right" withArrow>
            <UnstyledButton
              aria-label="New session"
              onClick={() => void navigate({ to: "/" })}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 40,
                height: 36,
                borderRadius: "var(--mantine-radius-sm)",
                color: "var(--nw-text-muted)",
                alignSelf: "center",
              }}
            >
              <Plus {...ICON_PROPS} />
            </UnstyledButton>
          </Tooltip>
        )}

        {attentionCount > 0 && (
          <div
            role="status"
            aria-label="awaiting approval"
            style={{
              marginTop: "var(--mantine-spacing-xs)",
              padding: expanded ? "4px var(--mantine-spacing-xs)" : "4px 6px",
              borderRadius: "var(--mantine-radius-sm)",
              background: "var(--nw-accent)",
              color: "var(--nw-bg)",
              fontSize: 12,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              justifyContent: expanded ? "flex-start" : "center",
              gap: 6,
            }}
          >
            <span>{attentionCount}</span>
            {expanded && <span>awaiting approval</span>}
          </div>
        )}

        {expanded && (
          <div
            style={{
              borderTop: "1px solid var(--nw-border)",
              marginTop: "var(--mantine-spacing-xs)",
              paddingTop: "var(--mantine-spacing-xs)",
              flex: 1,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              minHeight: 0,
            }}
          >
            <UnstyledButton
              onClick={() => setSessionsOpen((o) => !o)}
              aria-expanded={sessionsOpen}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "2px var(--mantine-spacing-xs)",
                borderRadius: "var(--mantine-radius-sm)",
                width: "100%",
                flexShrink: 0,
              }}
            >
              <Text
                size="xs"
                fw={700}
                tt="uppercase"
                c="dimmed"
                style={{ letterSpacing: "0.06em" }}
              >
                Recent sessions
              </Text>
              {sessionsOpen ? (
                <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />
              ) : (
                <ChevronRight {...ICON_PROPS} />
              )}
            </UnstyledButton>
            {sessionsOpen && (
              <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
                <SessionsSidebar />
              </div>
            )}
          </div>
        )}

        <div
          style={{
            borderTop: expanded ? "1px solid var(--nw-border)" : undefined,
            marginTop: expanded ? "var(--mantine-spacing-xs)" : "auto",
            paddingTop: expanded ? "var(--mantine-spacing-xs)" : 0,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <NavLink
            to="/runners"
            icon={<Server {...ICON_PROPS} />}
            label="Runners"
            compact={!expanded}
          />
          <NavLink
            to="/settings"
            icon={<Settings {...ICON_PROPS} />}
            label="Settings"
            compact={!expanded}
          />
        </div>

        <div
          style={{
            borderTop: "1px solid var(--nw-border)",
            marginTop: "var(--mantine-spacing-xs)",
            paddingTop: "var(--mantine-spacing-xs)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            alignItems: expanded ? "flex-start" : "center",
          }}
        >
          {expanded && ownerEmail && (
            <Text size="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
              {ownerEmail}
            </Text>
          )}
          {expanded ? (
            <Button
              size="xs"
              variant="subtle"
              leftSection={<LogOut {...ICON_PROPS} />}
              style={{ alignSelf: "flex-start" }}
              onClick={() => void logout()}
            >
              Log out
            </Button>
          ) : (
            <Tooltip label="Log out" position="right" withArrow>
              <UnstyledButton
                aria-label="Log out"
                onClick={() => void logout()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 40,
                  height: 36,
                  borderRadius: "var(--mantine-radius-sm)",
                  color: "var(--nw-text-muted)",
                }}
              >
                <LogOut {...ICON_PROPS} />
              </UnstyledButton>
            </Tooltip>
          )}
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
