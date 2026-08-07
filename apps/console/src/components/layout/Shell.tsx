import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bot,
  Settings,
  LogOut,
  ScrollText,
  PanelLeft,
  Plug,
  Telescope,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { ChatHost } from "@/components/layout/ChatHost";
import { useAuth } from "@/auth/AuthContext";
import { useSessions } from "@/hooks/useSessions";
import { cn } from "@/lib/utils";
import { ICON_NAV } from "@/lib/iconProps";

// Nowrap inside an overflow-hidden rail, and the fade finishes before the
// width does, so a label is never legible at an intermediate width. Medium
// because a 400 stroke on the dark panel reads dimmer than its own ink step.
const NAV_LABEL =
  "truncate whitespace-nowrap font-medium transition-opacity duration-(--duration-fast) delay-(--duration-base) group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0";

// The whole of the sidebar's navigation. Lists and actions belong to the pages.
const NAV_ITEMS = [
  { to: "/agent", label: "Agent", icon: Bot },
  { to: "/investigations", label: "Investigations", icon: Telescope },
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/audit", label: "Audit log", icon: ScrollText },
] as const;

export function Shell({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SidebarProvider>
      <ShellContent>{children}</ShellContent>
    </SidebarProvider>
  );
}

/* Navigation, the stage it pushes, and the chat's permanent home. What a page
   is made of is the route's business, so nothing here reads the pathname for
   anything but which nav item is lit. */
function ShellContent({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { toggleSidebar, isOverlay, openOverlay, setOpenOverlay } =
    useSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { logout } = useAuth();
  const { actionRequiredCount } = useSessions("investigation");

  function isActive(to: string): boolean {
    return pathname === to || pathname.startsWith(`${to}/`);
  }

  // In the overlay any navigation or action should also dismiss it.
  function dismissOverlay(): void {
    if (isOverlay) setOpenOverlay(false);
  }

  return (
    <>
      <a
        href="#main-content"
        className="absolute left-2 top-[-40px] z-[100] rounded-sm bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground no-underline focus:top-2"
      >
        Skip to content
      </a>

      <Sidebar collapsible="icon" variant="inset">
        {/* The gap goes with the label: 8px of nothing pushes the collapsed
            toggle off the icon column. */}
        <SidebarHeader className="h-14 flex-row items-center justify-between gap-2 overflow-hidden p-2 group-data-[collapsible=icon]:gap-0">
          <span
            className={cn(
              NAV_LABEL,
              "min-w-0 flex-1 text-lg font-semibold tracking-tight",
            )}
          >
            NightWarden
          </span>
          <SidebarTrigger
            size="icon"
            aria-label="Toggle sidebar"
            className="shrink-0 group-data-[collapsible=icon]:size-9"
          />
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    aria-label={label}
                    tooltip={label}
                    isActive={isActive(to)}
                    onClick={dismissOverlay}
                    render={<Link to={to} />}
                  >
                    <Icon {...ICON_NAV} />
                    <span className={NAV_LABEL}>{label}</span>
                    {/* A plain number, not a badge: it says how much work there
                        is, which is a readout rather than a notification. */}
                    {to === "/investigations" && actionRequiredCount > 0 && (
                      <span
                        className={cn(NAV_LABEL, "ml-auto tabular-nums")}
                        aria-label={`${actionRequiredCount} needing action`}
                      >
                        {actionRequiredCount}
                      </span>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                aria-label="Settings"
                tooltip="Settings"
                isActive={isActive("/settings")}
                onClick={dismissOverlay}
                render={<Link to="/settings" />}
              >
                <Settings {...ICON_NAV} />
                <span className={NAV_LABEL}>Settings</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                aria-label="Log out"
                tooltip="Log out"
                onClick={() => {
                  dismissOverlay();
                  void logout();
                }}
              >
                <LogOut {...ICON_NAV} />
                <span className={NAV_LABEL}>Log out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset
        id="main-content"
        tabIndex={-1}
        className="h-svh min-h-0 overflow-hidden lg:h-[calc(100svh-theme(spacing.6))]"
      >
        {/* Only while the sidebar is hidden: a panel that is not on screen
            cannot host the control that reopens it. */}
        {isOverlay && !openOverlay && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle sidebar"
            aria-expanded={false}
            className="absolute top-3 left-3 z-20 text-muted-foreground"
            onClick={() => toggleSidebar()}
          >
            <PanelLeft className="size-4.5" strokeWidth={1.5} aria-hidden />
          </Button>
        )}
        {/* Scrolling is the page's to decide: a column of content scrolls here,
            and a report beside a rail scrolls inside its own column. */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-auto">
          <ChatHost>{children}</ChatHost>
        </div>
      </SidebarInset>
    </>
  );
}
