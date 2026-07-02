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
import { Drawer } from "../ui/Drawer.js";
import { Text } from "../ui/Text.js";
import { Tooltip } from "../ui/Tooltip.js";
import { UnstyledButton } from "../ui/UnstyledButton.js";
import { useAuth } from "../auth/AuthContext.js";
import { useAttentionCount } from "../hooks/useAttentionCount.js";
import { useSidebarExpanded } from "../hooks/useSidebarExpanded.js";
import { SideRow, RAIL_WIDTH, EXPANDED_WIDTH, NAV_PAD } from "./SideRow.js";
import { SessionsSidebar } from "./SessionsSidebar.js";
import { SessionView } from "./SessionView.js";
import { SettingsModal } from "./SettingsModal.js";

const ICON_PROPS = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const HEADER_HEIGHT = 44;

export function Shell(): React.JSX.Element {
  const [expanded, toggleExpanded] = useSidebarExpanded();
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const params = useParams({ strict: false }) as { id?: string };
  const attentionCount = useAttentionCount();
  const { phase, logout } = useAuth();
  const navigate = useNavigate();
  const isMobile = useMediaQuery("(max-width: 767px)");

  /* /settings survives as an alias: it renders the session area with the
     settings modal open, so old links and muscle memory keep working. */
  const isSettingsAlias = pathname === "/settings";
  const settingsOpened = settingsOpen || isSettingsAlias;
  const isSessionArea =
    pathname === "/" || pathname.startsWith("/sessions/") || isSettingsAlias;
  const ownerEmail = phase.kind === "authenticated" ? phase.email : null;

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
            height: 38,
            flexShrink: 0,
          }}
        >
          {navExpanded && (
            <Text
              className="side-nowrap text-base font-semibold"
              style={{ paddingInlineStart: 4, letterSpacing: "-0.2px" }}
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
              borderRadius: "var(--radius-sm)",
              background: "var(--color-primary-fill)",
              color: "var(--color-card)",
              fontWeight: 600,
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
              marginTop: 8,
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
                padding: "2px 4px",
                borderRadius: "var(--radius-sm)",
                width: "100%",
                flexShrink: 0,
              }}
            >
              <Text
                className="side-nowrap text-xs font-semibold uppercase text-ink-muted"
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
            marginTop: 8,
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
          <SideRow
            icon={<Settings {...ICON_PROPS} />}
            label="Settings"
            expanded={navExpanded}
            onClick={() => setSettingsOpen(true)}
          />
        </div>

        <div
          style={{
            marginTop: 8,
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
              <Text className="side-nowrap text-xs text-ink-muted">
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
            <UnstyledButton
              aria-label="Open menu"
              onClick={() => setDrawerOpen(true)}
              style={{ display: "flex" }}
            >
              <MenuIcon {...ICON_PROPS} />
            </UnstyledButton>
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
