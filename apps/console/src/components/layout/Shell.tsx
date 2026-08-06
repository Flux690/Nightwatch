import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Link,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import {
  Bot,
  Settings,
  LogOut,
  ScrollText,
  PanelLeft,
  PanelRight,
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
import { useAuth } from "@/auth/AuthContext";
import { useSession } from "@/hooks/useSession";
import { useSessionReport } from "@/hooks/useSessionReport";
import { cn } from "@/lib/utils";
import { ICON_NAV } from "@/lib/iconProps";
import { ReportPanel } from "@/components/report/ReportPanel";
import { SessionView } from "@/pages/SessionView";

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

/* Attaches a stable, externally-owned DOM node as this element's child. The
   chat is portaled ONCE into it, so moving it between slots is a plain DOM
   re-parent and the chat never unmounts, which would drop a live stream. */
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

function ShellContent({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { toggleSidebar, isOverlay, openOverlay, setOpenOverlay } =
    useSidebar();

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Present on /agent/$id and /investigations/$id; Shell owns the one persistent
  // SessionView so a move between them is a prop change, not a remount.
  const { id: routeSessionId } = useParams({ strict: false }) as {
    id?: string;
  };
  const { logout } = useAuth();

  // The morph keys on what the session says it is, so the layout appears the
  // instant the session exists rather than waiting on the model.
  const session = useSession(routeSessionId ?? null);
  const report = useSessionReport(routeSessionId ?? null);
  const investigationView = session?.investigation === true;

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

  function isActive(to: string): boolean {
    return pathname === to || pathname.startsWith(`${to}/`);
  }

  // A session is on screen for both route families; the list at
  // /investigations is a page like any other.
  const isSessionArea =
    isActive("/agent") || pathname.startsWith("/investigations/");

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
        {/* The fall belongs to the agent's own surface, where the conversation
            runs the full stage. Every other page is flat ground. */}
        <div
          className={cn(
            "relative flex min-h-0 flex-1",
            isSessionArea ? "overflow-hidden" : "flex-col overflow-auto",
            isSessionArea && !investigationView && "lg:stage-fall",
          )}
        >
          {isSessionArea ? (
            investigationView ? (
              <>
                {/* Below lg the report runs the full stage, so it clears the
                    seat the sidebar toggle takes in the corner. */}
                <div className="min-w-0 flex-1 overflow-y-auto max-lg:pt-12 [contain:layout]">
                  <ReportPanel
                    report={report?.report ?? null}
                    actions={report?.actions ?? []}
                    evidence={report?.evidence ?? []}
                    conviction={report?.conviction ?? {}}
                    alerts={session?.alerts ?? []}
                  />
                </div>
                {/* Width, not presence, so it closes like the sidebar. Closed
                    it is zero-wide but present, so it leaves the accessibility
                    tree and the tab order too. */}
                <aside
                  aria-label="Investigation chat"
                  aria-hidden={!chatRailOpen}
                  inert={!chatRailOpen}
                  className={cn(
                    "flex shrink-0 flex-col overflow-hidden border-l transition-[width,border-color] duration-(--duration-panel) ease-panel",
                    // The edge says where the report stops. It fades out
                    // rather than switching off, leaving no hairline.
                    chatRailOpen
                      ? "w-(--container-rail) border-border"
                      : "w-0 border-transparent",
                  )}
                >
                  {/* The chat holds its own width while the panel narrows past
                      it, so nothing inside ever reflows. */}
                  <ChatSlot
                    node={chatNodeRef.current}
                    className={cn(
                      "flex min-h-0 w-(--container-rail) flex-1 shrink-0 flex-col pt-12 transition-opacity duration-(--duration-fast)",
                      chatRailOpen
                        ? "opacity-100 delay-(--duration-base)"
                        : "opacity-0 delay-0",
                    )}
                  />
                </aside>
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

        {/* A sibling, never a child: a panel that collapses cannot host the
            control that reopens it. Anchored to the inset so it keeps the
            sidebar toggle's centre line whatever sits above the content. */}
        {isSessionArea && investigationView && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={chatRailOpen ? "Hide the chat" : "Show the chat"}
            aria-expanded={chatRailOpen}
            className="absolute top-3 right-3 z-20 text-muted-foreground"
            onClick={() => setChatRailOpen((prev) => !prev)}
          >
            <PanelRight className="size-4.5" strokeWidth={1.5} aria-hidden />
          </Button>
        )}
      </SidebarInset>

      {/* Portaled once into the stable node, so the route change and the move
          between slots are prop/DOM moves rather than a remount. */}
      {isSessionArea &&
        createPortal(
          <SessionView sessionId={routeSessionId ?? null} />,
          chatNodeRef.current,
        )}
    </>
  );
}
