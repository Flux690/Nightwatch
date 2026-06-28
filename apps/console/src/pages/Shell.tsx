import { useState } from "react";
import { AppShell, Tooltip, UnstyledButton, Text } from "@mantine/core";
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
import { SideRow, RAIL_WIDTH, EXPANDED_WIDTH, NAV_PAD } from "./SideRow.js";
import { SessionsSidebar } from "./SessionsSidebar.js";
import { SessionView } from "./SessionView.js";

const ICON_PROPS = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;
const TRANSITION = "200ms ease";

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
        width: expanded ? EXPANDED_WIDTH : RAIL_WIDTH,
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
          padding: NAV_PAD,
          gap: 4,
          overflow: "hidden",
          transition: `width ${TRANSITION}`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 38,
            flexShrink: 0,
          }}
        >
          <Tooltip
            label={expanded ? "Collapse sidebar" : "Expand sidebar"}
            position="right"
            withArrow
            disabled={expanded}
          >
            <UnstyledButton
              className="nw-side-toggle"
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
        </div>

        <SideRow
          icon={<Plus {...ICON_PROPS} />}
          label="New session"
          expanded={expanded}
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
              background: "var(--nw-accent)",
              color: "var(--nw-bg)",
              fontWeight: 700,
              fontSize: 12,
              overflow: "hidden",
            }}
          >
            <span className="nw-side-row__icon">{attentionCount}</span>
            {expanded && (
              <span className="nw-side-row__label">awaiting approval</span>
            )}
          </div>
        )}

        {expanded ? (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              marginTop: 4,
              paddingTop: 4,
              borderTop: "1px solid var(--nw-border)",
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
            borderTop: "1px solid var(--nw-border)",
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
            expanded={expanded}
          />
          <SideRow
            icon={<ScrollText {...ICON_PROPS} />}
            label="Audit log"
            to="/audit"
            expanded={expanded}
          />
          <SideRow
            icon={<AlertCircle {...ICON_PROPS} />}
            label="Unresolved alerts"
            to="/unresolved-alerts"
            expanded={expanded}
          />
          <SideRow
            icon={<Settings {...ICON_PROPS} />}
            label="Settings"
            to="/settings"
            expanded={expanded}
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
            {expanded && ownerEmail && (
              <Text
                size="xs"
                c="dimmed"
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {ownerEmail}
              </Text>
            )}
          </div>
          <SideRow
            icon={<LogOut {...ICON_PROPS} />}
            label="Log out"
            expanded={expanded}
            onClick={() => void logout()}
          />
        </div>
      </AppShell.Navbar>

      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
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
  );
}
