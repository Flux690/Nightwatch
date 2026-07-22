import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Link,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import {
  Plus,
  Settings,
  LogOut,
  ScrollText,
  Menu,
  Plug,
  MessagesSquare,
  Sun,
  Moon,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/auth/AuthContext";
import { useAttentionCount } from "@/hooks/useAttentionCount";
import { useSessionReport } from "@/hooks/useSessionReport";
import { useSidebarExpanded } from "@/hooks/useSidebarExpanded";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { ICON_NAV, ICON_UI } from "@/lib/iconProps";
import { AuditRail } from "./AuditRail.js";
import { IntegrationsRail } from "./IntegrationsRail.js";
import { SessionsSidebar } from "./SessionsSidebar.js";
import { SettingsModal } from "./SettingsModal.js";
import { ReportPanel } from "@/components/report/ReportPanel";
import { SessionView } from "@/pages/SessionView";

export function Shell({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [expanded, toggleExpanded] = useSidebarExpanded();

  return (
    <SidebarProvider
      open={expanded}
      onOpenChange={(open) => {
        if (open !== expanded) toggleExpanded();
      }}
    >
      <ShellContent>{children}</ShellContent>
    </SidebarProvider>
  );
}

/* Attaches a stable, externally-owned DOM node as this element's child. The
   chat is portaled ONCE into that node; moving the node between slots is a
   plain DOM re-parent, so the chat component never unmounts (a portal whose
   container changes would remount it and drop live streams mid-run). */
function ChatSlot({
  node,
  className,
}: {
  node: HTMLElement;
  className?: string;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    host.appendChild(node);
    return () => {
      if (node.parentElement === host) host.removeChild(node);
    };
  }, [node]);
  return <div ref={hostRef} className={className} />;
}

/* One icon-rail entry: an icon-only control with a tooltip; navigation items
   render as links so they stay links for assistive tech. */
function RailItem({
  label,
  active = false,
  onClick,
  to,
  badge,
  children,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  to?: string;
  badge?: number;
  children: React.ReactNode;
}): React.JSX.Element {
  const className = cn(
    "relative flex size-9 items-center justify-center rounded-md transition-colors",
    active
      ? "bg-surface-active text-foreground"
      : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
  );
  const badgeEl =
    badge !== undefined && badge > 0 ? (
      <span
        role="status"
        aria-label="awaiting approval"
        className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-semibold leading-none text-warning-tint"
      >
        {badge > 99 ? "99+" : badge}
      </span>
    ) : null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          to !== undefined ? (
            <Link to={to} aria-label={label} className={className}>
              {children}
              {badgeEl}
            </Link>
          ) : (
            <button
              type="button"
              aria-label={label}
              className={className}
              onClick={onClick}
            >
              {children}
              {badgeEl}
            </button>
          )
        }
      />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/* The list rail's collapse handle, on its right edge. Present in both states -
   so the panel is always one click from collapsing or reopening - and mirrored
   by the cmd/ctrl+B shortcut. The icon rail is never affected. */
function PanelRail({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={expanded ? "Collapse panel" : "Expand panel"}
      onClick={onToggle}
      className="group/rail hidden w-1.5 shrink-0 cursor-pointer border-r border-border bg-sidebar transition-colors hover:bg-surface-hover md:block"
    >
      <span className="mx-auto block h-full w-px bg-transparent transition-colors group-hover/rail:bg-border-strong" />
    </button>
  );
}

function ShellContent({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { state, toggleSidebar, isMobile, setOpenMobile } = useSidebar();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const expanded = state === "expanded";

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Present only on /sessions/$id; Shell owns the one persistent SessionView so
  // the / -> /sessions/$id transition is a prop change, not a remount.
  const { id: routeSessionId } = useParams({ strict: false }) as {
    id?: string;
  };
  const attentionCount = useAttentionCount();
  const { logout } = useAuth();
  const { preference, toggle: toggleTheme } = useTheme();
  const navigate = useNavigate();

  // The morph: a session with a report is an investigation - chat moves to the
  // right rail and the report owns main. Conversations keep the centered chat.
  const report = useSessionReport(routeSessionId ?? null);
  const investigationView = routeSessionId !== undefined && report !== null;

  const [chatRailOpen, setChatRailOpen] = useState(true);
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "j" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setChatRailOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The chat's permanent DOM home, created once and re-parented between slots.
  const chatNodeRef = useRef<HTMLDivElement | null>(null);
  if (chatNodeRef.current === null) {
    chatNodeRef.current = document.createElement("div");
    chatNodeRef.current.className = "flex min-h-0 flex-1 flex-col";
  }

  const isSettingsAlias = pathname === "/settings";
  const settingsOpened = settingsOpen || isSettingsAlias;
  const isSessionArea =
    pathname === "/" || pathname.startsWith("/sessions/") || isSettingsAlias;

  function closeSettings(): void {
    setSettingsOpen(false);
    if (isSettingsAlias) void navigate({ to: "/" });
  }

  function isActive(to: string): boolean {
    return pathname === to || pathname.startsWith(`${to}/`);
  }

  // In the mobile overlay any navigation or action should also dismiss it.
  function dismissMobile(): void {
    if (isMobile) setOpenMobile(false);
  }

  const panelTitle = isSessionArea
    ? "Nightwatch"
    : isActive("/integrations")
      ? "Integrations"
      : "Audit log";

  const panelContent = isSessionArea ? (
    <SessionsSidebar />
  ) : isActive("/integrations") ? (
    <IntegrationsRail />
  ) : (
    <AuditRail />
  );

  // The list rail's sections, shared by the desktop in-flow panel and the
  // mobile sheet; `extraTop` carries the sheet-only primary nav.
  const panelSections = (extraTop?: React.ReactNode): React.JSX.Element => (
    <>
      <SidebarHeader className="h-11 justify-center px-2">
        <span className="min-w-0 truncate text-lg font-semibold tracking-tight">
          {panelTitle}
        </span>
      </SidebarHeader>
      <SidebarContent>
        {extraTop}
        {isSessionArea && attentionCount > 0 && (
          <div className="px-2 pt-1">
            <div
              className="flex h-8 items-center overflow-hidden rounded-sm bg-warning-tint text-sm font-semibold text-warning"
              aria-hidden="true"
            >
              <span className="flex h-full w-10 shrink-0 items-center justify-center">
                {attentionCount > 99 ? "99+" : attentionCount}
              </span>
              <span className="min-w-0 truncate">awaiting approval</span>
            </div>
          </div>
        )}
        <SidebarGroup className="min-h-0 flex-1">
          <SidebarGroupContent className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
            {panelContent}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  );

  const mobileNav = (
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label="New session"
            className="text-primary hover:text-primary-hover"
            onClick={() => {
              dismissMobile();
              void navigate({ to: "/" });
            }}
          >
            <Plus {...ICON_NAV} />
            <span>New session</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label="Integrations"
            isActive={isActive("/integrations")}
            onClick={dismissMobile}
            render={<Link to="/integrations" />}
          >
            <Plug {...ICON_NAV} />
            <span>Integrations</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label="Audit log"
            isActive={isActive("/audit")}
            onClick={dismissMobile}
            render={<Link to="/audit" />}
          >
            <ScrollText {...ICON_NAV} />
            <span>Audit log</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label="Settings"
            onClick={() => {
              dismissMobile();
              setSettingsOpen(true);
            }}
          >
            <Settings {...ICON_NAV} />
            <span>Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label="Log out"
            onClick={() => {
              dismissMobile();
              void logout();
            }}
          >
            <LogOut {...ICON_NAV} />
            <span>Log out</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );

  return (
    <>
      <a
        href="#main-content"
        className="absolute left-2 top-[-40px] z-[100] rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground no-underline focus:top-2"
      >
        Skip to content
      </a>

      {/* Icon rail: always visible on desktop, never collapses. The mobile
          sheet carries the same destinations. */}
      <nav
        aria-label="Primary"
        className="hidden w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-2 md:flex"
      >
        <RailItem
          label="New session"
          onClick={() => void navigate({ to: "/" })}
        >
          <Plus {...ICON_NAV} className="text-primary" />
        </RailItem>
        <RailItem
          label="Sessions"
          to="/"
          active={isSessionArea}
          badge={attentionCount}
        >
          <MessagesSquare {...ICON_NAV} />
        </RailItem>
        <RailItem
          label="Integrations"
          to="/integrations"
          active={isActive("/integrations")}
        >
          <Plug {...ICON_NAV} />
        </RailItem>
        <RailItem label="Audit log" to="/audit" active={isActive("/audit")}>
          <ScrollText {...ICON_NAV} />
        </RailItem>

        <div className="mt-auto flex flex-col items-center gap-1">
          <RailItem
            label={preference === "dark" ? "Switch to light" : "Switch to dark"}
            onClick={toggleTheme}
          >
            {preference === "dark" ? (
              <Sun {...ICON_NAV} />
            ) : (
              <Moon {...ICON_NAV} />
            )}
          </RailItem>
          <RailItem label="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings {...ICON_NAV} />
          </RailItem>
          <RailItem label="Log out" onClick={() => void logout()}>
            <LogOut {...ICON_NAV} />
          </RailItem>
        </div>
      </nav>

      {/* List rail: in-flow beside the icon rail (both always visible on
          desktop); cmd/ctrl+B or the edge handle collapses only this panel. */}
      {!isMobile && expanded && (
        <aside
          data-slot="list-rail"
          data-state="expanded"
          className="flex w-80 shrink-0 flex-col bg-sidebar"
        >
          {panelSections()}
        </aside>
      )}
      {!isMobile && <PanelRail expanded={expanded} onToggle={toggleSidebar} />}

      {/* Mobile: the same panel as an off-canvas sheet. */}
      {isMobile && (
        <Sidebar collapsible="offcanvas">{panelSections(mobileNav)}</Sidebar>
      )}

      <SidebarInset
        id="main-content"
        tabIndex={-1}
        className="h-svh min-h-0 overflow-hidden"
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2 md:hidden">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open menu"
            onClick={() => toggleSidebar()}
          >
            <Menu {...ICON_UI} />
          </Button>
          <span className="text-sm font-semibold">Nightwatch</span>
        </header>
        <div
          className={cn(
            "flex min-h-0 flex-1",
            isSessionArea ? "overflow-hidden" : "flex-col overflow-auto",
          )}
        >
          {isSessionArea ? (
            investigationView ? (
              <>
                <div className="min-w-0 flex-1 overflow-y-auto">
                  <ReportPanel report={report} />
                </div>
                {chatRailOpen && (
                  <aside
                    aria-label="Investigation chat"
                    className="flex w-(--container-rail) max-w-[45vw] shrink-0 flex-col border-l border-border"
                  >
                    <ChatSlot
                      node={chatNodeRef.current}
                      className="flex min-h-0 flex-1 flex-col"
                    />
                  </aside>
                )}
              </>
            ) : (
              <ChatSlot
                node={chatNodeRef.current}
                className="flex min-h-0 flex-1 flex-col"
              />
            )
          ) : (
            children
          )}
        </div>
      </SidebarInset>

      {/* Portaled once into the stable node: the / <-> /sessions/$id transition
          and the conversation <-> investigation morph are both prop/DOM moves,
          never a remount. */}
      {isSessionArea &&
        createPortal(
          <SessionView sessionId={routeSessionId ?? null} />,
          chatNodeRef.current,
        )}

      <SettingsModal opened={settingsOpened} onClose={closeSettings} />
    </>
  );
}
