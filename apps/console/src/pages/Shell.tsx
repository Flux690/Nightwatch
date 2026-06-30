import { useEffect, useState } from "react";
import { AppShell, Tooltip, UnstyledButton, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  Outlet,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import {
  AlertCircle,
  Plus,
  Settings,
  LogOut,
  Menu as MenuIcon,
  PanelRightClose,
  PanelRightOpen,
  ChevronRight,
  ChevronDown,
  ScrollText,
  Network,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext.js";
import { useAttentionCount } from "../hooks/useAttentionCount.js";
import { useSidebarExpanded } from "../hooks/useSidebarExpanded.js";
import { Drawer } from "../ui/Drawer.js";
import { SideRow, RAIL_WIDTH, EXPANDED_WIDTH, NAV_PAD } from "./SideRow.js";
import { SessionsSidebar } from "./SessionsSidebar.js";
import { SessionView } from "./SessionView.js";

const ICON_PROPS = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const TRANSITION = "200ms ease";

export function Shell(): React.JSX.Element {
  const [expanded, toggleExpanded] = useSidebarExpanded();
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const params = useParams({ strict: false }) as { id?: string };
  const attentionCount = useAttentionCount();
  const { phase, logout } = useAuth();
  const navigate = useNavigate();
  const isMobile = useMediaQuery("(max-width: 767px)");

  const isSessionArea = pathname === "/" || pathname.startsWith("/sessions/");
  const ownerEmail = phase.kind === "authenticated" ? phase.email : null;

  // Closes the drawer on any navigation - links, New session, and session
  // rows all change the route, so this one effect covers every case.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Shared between the persistent desktop rail and the mobile drawer body.
  // navExpanded is forced true for the drawer, which has no rail/collapsed
  // state of its own; showToggle hides the (meaningless, off-canvas) collapse
  // button there.
  function navContent(
    navExpanded: boolean,
    showToggle: boolean,
  ): React.ReactNode {
    return (
      <>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 38,
            flexShrink: 0,
          }}
        >
          {navExpanded && (
            <Text
              size="sm"
              fw={650}
              className="side-nowrap"
              style={{ paddingInlineStart: 4 }}
            >
              Nightwatch
            </Text>
          )}
          {showToggle && (
            <Tooltip
              label={expanded ? "Collapse sidebar" : "Expand sidebar"}
              position="right"
              withArrow
              disabled={expanded}
            >
              <UnstyledButton
                className="side-toggle"
                aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
                onClick={toggleExpanded}
              >
                {expanded ? (
                  <PanelRightClose {...ICON_PROPS} />
                ) : (
                  <PanelRightOpen {...ICON_PROPS} />
                )}
              </UnstyledButton>
            </Tooltip>
          )}
        </div>

        <SideRow
          icon={<Plus {...ICON_PROPS} />}
          label="New session"
          expanded={navExpanded}
          onClick={() => void navigate({ to: "/" })}
          primary
        />

        {attentionCount > 0 && (
          <div
            role="status"
            aria-label="awaiting approval"
            style={{
              display: "flex",
              alignItems: "center",
              height: 34,
              borderRadius: "var(--mantine-radius-sm)",
              background: "var(--color-accent)",
              color: "var(--color-canvas)",
              fontWeight: 700,
              fontSize: 12,
              overflow: "hidden",
            }}
          >
            <span className="side-row__icon">
              {attentionCount > 99 ? "99+" : attentionCount}
            </span>
            {navExpanded && (
              <span className="side-row__label">awaiting approval</span>
            )}
          </div>
        )}

        {navExpanded ? (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              marginTop: 4,
              paddingTop: 4,
              borderTop: "1px solid var(--color-line)",
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
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
                className="side-nowrap"
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
        ) : (
          <div style={{ flex: 1 }} />
        )}

        <div
          style={{
            borderTop: "1px solid var(--color-line)",
            marginTop: 4,
            paddingTop: 4,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <SideRow
            icon={<Network {...ICON_PROPS} />}
            label="Fleet"
            to="/fleet"
            expanded={navExpanded}
          />
          <SideRow
            icon={<Settings {...ICON_PROPS} />}
            label="Settings"
            to="/settings"
            expanded={navExpanded}
          />
          <SideRow
            icon={<ScrollText {...ICON_PROPS} />}
            label="Audit log"
            to="/audit"
            expanded={navExpanded}
          />
          <SideRow
            icon={<AlertCircle {...ICON_PROPS} />}
            label="Unresolved alerts"
            to="/unresolved-alerts"
            expanded={navExpanded}
          />
        </div>

        <div
          style={{
            marginTop: 4,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            style={{
              minHeight: 16,
              paddingInline: 4,
              overflow: "hidden",
            }}
          >
            {navExpanded && ownerEmail && (
              <Text size="xs" c="dimmed" className="side-nowrap">
                {ownerEmail}
              </Text>
            )}
          </div>
          <SideRow
            icon={<LogOut {...ICON_PROPS} />}
            label="Log out"
            expanded={navExpanded}
            onClick={() => void logout()}
          />
        </div>
      </>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      {isMobile && (
        <div className="mobile-topbar">
          <UnstyledButton
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
            style={{ display: "flex" }}
          >
            <MenuIcon {...ICON_PROPS} />
          </UnstyledButton>
          <Text size="sm" fw={650}>
            Nightwatch
          </Text>
        </div>
      )}

      <AppShell
        navbar={{
          width: isMobile ? 0 : expanded ? EXPANDED_WIDTH : RAIL_WIDTH,
          breakpoint: 0,
        }}
        padding={0}
        styles={{ main: { background: "var(--color-canvas)" } }}
        style={{ flex: 1, minHeight: 0 }}
      >
        {!isMobile && (
          <AppShell.Navbar
            style={{
              background: "var(--color-surface)",
              borderRight: "1px solid var(--color-line)",
              display: "flex",
              flexDirection: "column",
              padding: NAV_PAD,
              gap: 4,
              overflow: "hidden",
              transition: `width ${TRANSITION}`,
            }}
          >
            {navContent(expanded, true)}
          </AppShell.Navbar>
        )}

        <AppShell.Main
          id="main-content"
          tabIndex={-1}
          style={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
            transition: `padding ${TRANSITION}`,
            // Session area manages its own internal scroll; other pages (Settings,
            // Fleet) need the main container to scroll normally.
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

      {isMobile && (
        <Drawer
          opened={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          position="left"
          size={EXPANDED_WIDTH}
          withCloseButton={false}
        >
          {navContent(true, false)}
        </Drawer>
      )}
    </div>
  );
}
