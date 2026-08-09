import { Link, useRouterState } from "@tanstack/react-router";
import { Bot, Settings, LogOut, Plug, Telescope } from "lucide-react";

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
  SidebarMenuLabel,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useAuth } from "@/auth/AuthContext";
import { cn } from "@/lib/utils";
import { ICON_NAV } from "@/lib/iconProps";

// Medium because a 400 stroke on the dark panel reads dimmer than its own ink
// step. The collapse behaviour belongs to the label slot, not to here.
const NAV_LABEL = "font-medium";

// The whole of the sidebar's navigation. Lists and actions belong to the pages.
const NAV_ITEMS = [
  { to: "/agent", label: "Agent", icon: Bot },
  { to: "/investigations", label: "Investigations", icon: Telescope },
  { to: "/integrations", label: "Integrations", icon: Plug },
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

/* Navigation and the stage it pushes. What a page is made of is the route's
   business, so nothing here reads the pathname for anything but which nav item
   is lit. */
function ShellContent({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { isOverlay, setOpenOverlay } = useSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { logout } = useAuth();

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
        {/* The same 48px bar the stage carries, begun at the same inset, so the
            wordmark and the page's own title sit on one line. The gap goes with
            the label: 8px of nothing pushes the collapsed toggle off centre. */}
        <SidebarHeader className="h-12 flex-row items-center justify-between gap-2 overflow-hidden px-2 lg:mt-3 group-data-[collapsible=icon]:gap-0">
          <span
            className={cn(
              // Full ink: the wordmark is the one thing in the panel that names
              // the product, and the panel's own ink step is its dimmest.
              "nav-label-motion min-w-0 flex-1 truncate whitespace-nowrap text-lg font-semibold tracking-tight text-foreground",
              "group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0",
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
                    <SidebarMenuLabel className={NAV_LABEL}>
                      {label}
                    </SidebarMenuLabel>
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
                <SidebarMenuLabel className={NAV_LABEL}>
                  Settings
                </SidebarMenuLabel>
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
                <SidebarMenuLabel className={NAV_LABEL}>
                  Log out
                </SidebarMenuLabel>
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
        {/* Scrolling is the page's to decide: a column of content scrolls here,
            and a report beside a rail scrolls inside its own column. */}
        <div className="relative flex min-h-0 flex-1 flex-col overflow-auto">
          {children}
        </div>
      </SidebarInset>
    </>
  );
}
