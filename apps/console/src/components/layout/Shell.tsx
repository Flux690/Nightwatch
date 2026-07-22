import { useState } from "react";
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
  PanelLeft,
  Menu,
  Plug,
  MessagesSquare,
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
import { useSidebarExpanded } from "@/hooks/useSidebarExpanded";
import { cn } from "@/lib/utils";
import { ICON_NAV, ICON_UI } from "@/lib/iconProps";
import { SessionsSidebar } from "./SessionsSidebar.js";
import { SettingsModal } from "./SettingsModal.js";
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

function ShellContent({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { state, toggleSidebar, isMobile, setOpenMobile } = useSidebar();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Present only on /sessions/$id; Shell owns the one persistent SessionView so
  // the / -> /sessions/$id transition is a prop change, not a remount.
  const { id: routeSessionId } = useParams({ strict: false }) as {
    id?: string;
  };
  const attentionCount = useAttentionCount();
  const { logout } = useAuth();
  const navigate = useNavigate();

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

  return (
    <>
      <a
        href="#main-content"
        className="absolute left-2 top-[-40px] z-[100] rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground no-underline focus:top-2"
      >
        Skip to content
      </a>

      {/* Icon rail: always-visible primary navigation (desktop only; the
          mobile sheet carries the same actions). */}
      <nav
        aria-label="Primary"
        className="hidden w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-2 md:flex"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={
            state === "collapsed" ? "Expand sidebar" : "Collapse sidebar"
          }
          onClick={() => toggleSidebar()}
        >
          <PanelLeft {...ICON_UI} />
        </Button>

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
          <RailItem label="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings {...ICON_NAV} />
          </RailItem>
          <RailItem label="Log out" onClick={() => void logout()}>
            <LogOut {...ICON_NAV} />
          </RailItem>
        </div>
      </nav>

      {/* List rail: section-scoped content. Sessions only for now; the
          integrations and audit rails arrive with their milestones. */}
      {isSessionArea && (
        <Sidebar collapsible="offcanvas">
          <SidebarHeader className="h-11 flex-row items-center justify-between">
            <span className="min-w-0 truncate px-2 text-lg font-semibold tracking-tight">
              Nightwatch
            </span>
          </SidebarHeader>

          <SidebarContent>
            {/* Mobile-only primary nav: the icon rail is desktop-only, so the
                sheet carries the same destinations. isMobile is a runtime
                check, so desktop never renders duplicates. */}
            {isMobile && (
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
            )}

            {attentionCount > 0 && (
              <div className="px-2">
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
                <SessionsSidebar />
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
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
            "flex min-h-0 flex-1 flex-col",
            isSessionArea ? "overflow-hidden" : "overflow-auto",
          )}
        >
          {isSessionArea ? (
            <SessionView sessionId={routeSessionId ?? null} />
          ) : (
            children
          )}
        </div>
      </SidebarInset>

      <SettingsModal opened={settingsOpened} onClose={closeSettings} />
    </>
  );
}
