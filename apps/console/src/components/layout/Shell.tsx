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
  PanelRight,
  Plug,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
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
import { useAttentionCount } from "@/hooks/useAttentionCount";
import { useSession } from "@/hooks/useSession";
import { useSessionReport } from "@/hooks/useSessionReport";
import { cn } from "@/lib/utils";
import { ICON_NAV, ICON_UI } from "@/lib/iconProps";
import { SessionsSidebar } from "./SessionsSidebar.js";
import { SettingsModal } from "./SettingsModal.js";
import { ReportPanel } from "@/components/report/ReportPanel";
import { SessionView } from "@/pages/SessionView";

// Nowrap inside an overflow-hidden rail, and the fade finishes before the
// width does, so a label is never legible at an intermediate width.
const NAV_LABEL =
  "truncate whitespace-nowrap transition-opacity duration-(--duration-fast) delay-(--duration-fast) motion-reduce:transition-none group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:delay-0";

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
  const { count: attentionCount, firstSessionId: attentionSessionId } =
    useAttentionCount();
  const { logout } = useAuth();
  const navigate = useNavigate();

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

  // In the mobile sheet any navigation or action should also dismiss it.
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
              <SidebarMenuItem>
                <SidebarMenuButton
                  aria-label="New session"
                  tooltip="New session"
                  className="text-primary hover:text-primary-hover"
                  onClick={() => {
                    dismissMobile();
                    void navigate({ to: "/" });
                  }}
                >
                  <Plus {...ICON_NAV} />
                  <span className={NAV_LABEL}>New session</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  aria-label="Integrations"
                  tooltip="Integrations"
                  isActive={isActive("/integrations")}
                  onClick={dismissMobile}
                  render={<Link to="/integrations" />}
                >
                  <Plug {...ICON_NAV} />
                  <span className={NAV_LABEL}>Integrations</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  aria-label="Audit log"
                  tooltip="Audit log"
                  isActive={isActive("/audit")}
                  onClick={dismissMobile}
                  render={<Link to="/audit" />}
                >
                  <ScrollText {...ICON_NAV} />
                  <span className={NAV_LABEL}>Audit log</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>

          {/* Sessions are not meaningful as icons, so the zone leaves the
              collapsed rail entirely. A sheet is never an icon rail. */}
          {(isMobile || state === "expanded") && (
            <SidebarGroup className="min-h-0 flex-1">
              <SidebarGroupLabel>Sessions</SidebarGroupLabel>
              {attentionCount > 0 && attentionSessionId !== null && (
                /* A link, not a notice: knowing something waits is useless
                   without a way to reach it. */
                <Link
                  to="/sessions/$id"
                  params={{ id: attentionSessionId }}
                  aria-label={`${attentionCount} awaiting approval - open the first`}
                  onClick={dismissMobile}
                  className="mb-1 flex h-8 items-center overflow-hidden rounded-sm bg-warning-tint text-sm font-semibold text-warning hover:brightness-95"
                >
                  <span className="flex h-full w-10 shrink-0 items-center justify-center">
                    {attentionCount > 99 ? "99+" : attentionCount}
                  </span>
                  <span className="min-w-0 truncate">awaiting approval</span>
                </Link>
              )}
              <SidebarGroupContent className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
                <SessionsSidebar />
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                aria-label="Settings"
                tooltip="Settings"
                onClick={() => {
                  dismissMobile();
                  setSettingsOpen(true);
                }}
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
                  dismissMobile();
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
          <span className="text-sm font-semibold">NightWarden</span>
        </header>
        <div
          className={cn(
            "relative flex min-h-0 flex-1",
            isSessionArea ? "overflow-hidden" : "flex-col overflow-auto",
          )}
        >
          {isSessionArea ? (
            investigationView ? (
              <>
                <div className="min-w-0 flex-1 overflow-y-auto">
                  <ReportPanel
                    report={report?.report ?? null}
                    actions={report?.actions ?? []}
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
                    "flex shrink-0 flex-col overflow-hidden border-l transition-[width,border-color] duration-(--duration-base) ease-linear motion-reduce:transition-none",
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
                      "flex min-h-0 w-(--container-rail) flex-1 shrink-0 flex-col pt-14 transition-opacity duration-(--duration-fast) motion-reduce:transition-none",
                      chatRailOpen
                        ? "opacity-100 delay-(--duration-fast)"
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
          <button
            type="button"
            aria-label={chatRailOpen ? "Hide the chat" : "Show the chat"}
            aria-expanded={chatRailOpen}
            className="absolute top-3 right-3 z-20 flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:top-14"
            onClick={() => setChatRailOpen((prev) => !prev)}
          >
            <PanelRight className="size-4.5" strokeWidth={1.5} aria-hidden />
          </button>
        )}
      </SidebarInset>

      {/* Portaled once into the stable node, so the route change and the move
          between slots are prop/DOM moves rather than a remount. */}
      {isSessionArea &&
        createPortal(
          <SessionView sessionId={routeSessionId ?? null} />,
          chatNodeRef.current,
        )}

      <SettingsModal opened={settingsOpened} onClose={closeSettings} />
    </>
  );
}
