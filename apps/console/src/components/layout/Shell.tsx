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
  Network,
  PanelLeft,
  Menu,
  Plug,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
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

      <Sidebar collapsible="icon">
        <SidebarHeader className="h-11 flex-row items-center justify-between group-data-[collapsible=icon]:justify-center">
          <span className="min-w-0 truncate px-2 text-lg font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            Nightwatch
          </span>
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
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="New session"
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
                  tooltip="Fleet"
                  aria-label="Fleet"
                  isActive={isActive("/fleet")}
                  onClick={dismissMobile}
                  render={<Link to="/fleet" />}
                >
                  <Network {...ICON_NAV} />
                  <span>Fleet</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Audit log"
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
                  tooltip="Integrations"
                  aria-label="Integrations"
                  isActive={isActive("/integrations")}
                  onClick={dismissMobile}
                  render={<Link to="/integrations" />}
                >
                  <Plug {...ICON_NAV} />
                  <span>Integrations</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>

          {attentionCount > 0 && (
            <div className="px-2">
              <div
                role="status"
                aria-label="awaiting approval"
                className="flex h-8 items-center overflow-hidden rounded-sm bg-warning-tint text-xs font-semibold text-warning"
              >
                <span className="flex h-full w-10 shrink-0 items-center justify-center">
                  {attentionCount > 99 ? "99+" : attentionCount}
                </span>
                <span className="min-w-0 truncate group-data-[collapsible=icon]:hidden">
                  awaiting approval
                </span>
              </div>
            </div>
          )}

          <SidebarGroup className="min-h-0 flex-1 group-data-[collapsible=icon]:hidden">
            <SidebarGroupLabel>Recent sessions</SidebarGroupLabel>
            <SidebarGroupContent className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
              <SessionsSidebar />
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarGroup className="mt-auto pb-4">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Settings"
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
                  tooltip="Log out"
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
        </SidebarContent>

        <SidebarRail />
      </Sidebar>

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
