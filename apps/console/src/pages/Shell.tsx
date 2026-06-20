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
import type { ApprovalRequest, ConsoleEvent } from "@nightwatch/shared";
import { useAuth } from "../auth/AuthContext.js";
import { useConsoleWs } from "../hooks/useConsoleWs.js";
import { SessionsSidebar } from "./Sessions.js";
import { SessionView } from "./SessionView.js";

const SIDEBAR_KEY = "nw:sidebar-expanded";
const EXPANDED_WIDTH = 250;
const COLLAPSED_WIDTH = 60;

function IconPlus(): React.JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M9 3.75v10.5M3.75 9h10.5" />
    </svg>
  );
}

function IconServer(): React.JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2.5" width="14" height="5" rx="1" />
      <rect x="2" y="10.5" width="14" height="5" rx="1" />
      <circle cx="5" cy="5" r="0.75" fill="currentColor" stroke="none" />
      <circle cx="5" cy="13" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconGear(): React.JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="2.5" />
      <path d="M9 1v2M9 15v2M1 9h2M15 9h2M3.1 3.1l1.4 1.4M13.5 13.5l1.4 1.4M3.1 14.9l1.4-1.4M13.5 4.5l1.4-1.4" />
    </svg>
  );
}

function IconLogOut(): React.JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 3H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h4" />
      <path d="M12 13l4-4-4-4M16 9H7" />
    </svg>
  );
}

function IconChevronLeft(): React.JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 13l-4-4 4-4" />
    </svg>
  );
}

function IconChevronRight(): React.JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 5l4 4-4 4" />
    </svg>
  );
}

function IconChevronDown(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5l4 4 4-4" />
    </svg>
  );
}

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
              {expanded ? <IconChevronLeft /> : <IconChevronRight />}
            </UnstyledButton>
          </Tooltip>
        </div>

        {expanded ? (
          <Button
            leftSection={<IconPlus />}
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
              <IconPlus />
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
              {sessionsOpen ? <IconChevronDown /> : <IconChevronRight />}
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
            icon={<IconServer />}
            label="Runners"
            compact={!expanded}
          />
          <NavLink
            to="/settings"
            icon={<IconGear />}
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
              leftSection={<IconLogOut />}
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
                <IconLogOut />
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
