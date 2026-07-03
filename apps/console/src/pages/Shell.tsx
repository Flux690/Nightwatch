import { useEffect, useState } from "react";
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
import {
  AppShell,
  AppShellHeader,
  AppShellNavbar,
  AppShellMain,
} from "../ui/AppShell.js";
import { Button } from "../ui/Button.js";
import { Drawer } from "../ui/Drawer.js";
import { Text } from "../ui/Text.js";
import { Tooltip } from "../ui/Tooltip.js";
import { ICON_NAV, ICON_INLINE } from "../ui/iconProps.js";
import { useAuth } from "../auth/AuthContext.js";
import { useAttentionCount } from "../hooks/useAttentionCount.js";
import { useSidebarExpanded } from "../hooks/useSidebarExpanded.js";
import { SideRow, RAIL_WIDTH, EXPANDED_WIDTH, NAV_PAD } from "./SideRow.js";
import { SessionsSidebar } from "./SessionsSidebar.js";
import { SessionView } from "./SessionView.js";
import { SettingsModal } from "./SettingsModal.js";

const HEADER_HEIGHT = 44;

export function Shell(): React.JSX.Element {
  const [expanded, toggleExpanded] = useSidebarExpanded();
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const params = useParams({ strict: false }) as { id?: string };
  const attentionCount = useAttentionCount();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const isMobile = useMediaQuery("(max-width: 767px)");

  const isSettingsAlias = pathname === "/settings";
  const settingsOpened = settingsOpen || isSettingsAlias;
  const isSessionArea =
    pathname === "/" || pathname.startsWith("/sessions/") || isSettingsAlias;

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  function closeSettings(): void {
    setSettingsOpen(false);
    if (isSettingsAlias) void navigate({ to: "/" });
  }

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
            height: 36,
            flexShrink: 0,
          }}
        >
          {navExpanded && (
            <Text
              className="side-nowrap text-base font-semibold"
              style={{ paddingInlineStart: 8, letterSpacing: "-0.2px" }}
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
              <Button
                variant="plain"
                className="side-toggle"
                aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
                onClick={toggleExpanded}
              >
                {expanded ? (
                  <PanelRightClose {...ICON_NAV} />
                ) : (
                  <PanelRightOpen {...ICON_NAV} />
                )}
              </Button>
            </Tooltip>
          )}
        </div>

        <nav aria-label="Main">
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <SideRow
              icon={<Plus {...ICON_NAV} />}
              label="New session"
              expanded={navExpanded}
              onClick={() => void navigate({ to: "/" })}
              primary
            />
          </ul>
        </nav>

        {attentionCount > 0 && (
          <div
            role="status"
            aria-label="awaiting approval"
            className="attention-pill"
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
              marginTop: 8,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <Button
              variant="plain"
              onClick={() => setSessionsOpen((o) => !o)}
              aria-expanded={sessionsOpen}
              className="sessions-toggle"
            >
              <Text
                className="side-nowrap text-xs font-medium uppercase text-ink-muted"
                style={{ letterSpacing: "0.06em" }}
              >
                Recent sessions
              </Text>
              {sessionsOpen ? (
                <ChevronDown {...ICON_INLINE} />
              ) : (
                <ChevronRight {...ICON_NAV} />
              )}
            </Button>
            {sessionsOpen && (
              <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
                <SessionsSidebar />
              </div>
            )}
          </div>
        ) : (
          <div style={{ flex: 1 }} />
        )}

        <nav aria-label="Utilities">
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              marginTop: 8,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <SideRow
              icon={<Network {...ICON_NAV} />}
              label="Fleet"
              to="/fleet"
              expanded={navExpanded}
            />
            <SideRow
              icon={<ScrollText {...ICON_NAV} />}
              label="Audit log"
              to="/audit"
              expanded={navExpanded}
            />
            <SideRow
              icon={<AlertCircle {...ICON_NAV} />}
              label="Unresolved alerts"
              to="/unresolved-alerts"
              expanded={navExpanded}
            />
            <SideRow
              icon={<Settings {...ICON_NAV} />}
              label="Settings"
              expanded={navExpanded}
              onClick={() => setSettingsOpen(true)}
            />
            <SideRow
              icon={<LogOut {...ICON_NAV} />}
              label="Log out"
              expanded={navExpanded}
              onClick={() => void logout()}
            />
          </ul>
        </nav>
      </>
    );
  }

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      <AppShell
        navbar={{
          width: isMobile ? 0 : expanded ? EXPANDED_WIDTH : RAIL_WIDTH,
          breakpoint: 0,
        }}
        header={{ height: HEADER_HEIGHT, collapsed: !isMobile }}
        transitionDuration={200}
      >
        {isMobile && (
          <AppShellHeader className="mobile-topbar">
            <Button
              variant="plain"
              aria-label="Open menu"
              onClick={() => setDrawerOpen(true)}
              style={{ display: "flex" }}
            >
              <MenuIcon {...ICON_NAV} />
            </Button>
            <Text className="text-sm font-semibold">Nightwatch</Text>
          </AppShellHeader>
        )}

        {!isMobile && (
          <AppShellNavbar
            style={{
              display: "flex",
              flexDirection: "column",
              padding: NAV_PAD,
              gap: 4,
              overflow: "hidden",
            }}
          >
            {navContent(expanded, true)}
          </AppShellNavbar>
        )}

        <AppShellMain
          id="main-content"
          tabIndex={-1}
          style={{
            display: "flex",
            flexDirection: "column",
            height: "100dvh",
            overflow: isSessionArea ? "hidden" : "auto",
          }}
        >
          {isSessionArea ? (
            <SessionView sessionId={params.id ?? null} />
          ) : (
            <Outlet />
          )}
        </AppShellMain>
      </AppShell>

      <SettingsModal opened={settingsOpened} onClose={closeSettings} />

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
    </>
  );
}
