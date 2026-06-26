import { useState, useCallback } from "react";
import { AppShell, Tooltip, UnstyledButton, Button, Text } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import {
  AlertCircle,
  Plus,
  Server,
  ServerCog,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ScrollText,
  Network,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext.js";
import { useAttentionCount } from "../hooks/useAttentionCount.js";
import { SessionsSidebar } from "./SessionsSidebar.js";
import { SessionView } from "./SessionView.js";
import { AddServerWizard } from "./AddServerWizard.js";

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
  const [wizardOpen, setWizardOpen] = useState(false);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const params = useParams({ strict: false }) as { id?: string };
  const attentionCount = useAttentionCount();
  const { phase, logout } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const isSessionArea = pathname === "/" || pathname.startsWith("/sessions/");
  const ownerEmail = phase.kind === "authenticated" ? phase.email : null;

  function handleWizardClose(): void {
    setWizardOpen(false);
    void queryClient.invalidateQueries({ queryKey: ["runners"] });
    void queryClient.invalidateQueries({ queryKey: ["fleet"] });
  }

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

        {expanded ? (
          <Button
            leftSection={<ServerCog {...ICON_PROPS} />}
            variant="subtle"
            size="sm"
            fullWidth
            onClick={() => setWizardOpen(true)}
          >
            Add a server
          </Button>
        ) : (
          <Tooltip label="Add a server" position="right" withArrow>
            <UnstyledButton
              aria-label="Add a server"
              onClick={() => setWizardOpen(true)}
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
              <ServerCog {...ICON_PROPS} />
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
            to="/fleet"
            icon={<Network {...ICON_PROPS} />}
            label="Fleet"
            compact={!expanded}
          />
          <NavLink
            to="/audit"
            icon={<ScrollText {...ICON_PROPS} />}
            label="Audit log"
            compact={!expanded}
          />
          <NavLink
            to="/unresolved-alerts"
            icon={<AlertCircle {...ICON_PROPS} />}
            label="Unresolved alerts"
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

      <AddServerWizard opened={wizardOpen} onClose={handleWizardClose} />
    </AppShell>
  );
}
