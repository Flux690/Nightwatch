import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { RouterProvider } from "@tanstack/react-router";

import { AuthProvider } from "@/auth/AuthContext";
import { ConsoleWsProvider } from "@/hooks/ConsoleWsProvider";
import { Shell } from "@/components/layout/Shell";
import { SessionView } from "@/pages/SessionView";

function ShellLayout(): React.JSX.Element {
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

const OWNER_EMAIL = "admin@example.com";

let latestWs: MockWs | null = null;
const allWsInstances: MockWs[] = [];

class MockWs {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWs.OPEN;
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  close = vi.fn();

  constructor(_url: string) {
    latestWs = this;
    allWsInstances.push(this);
  }

  push(envelope: object): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }
}

function broadcast(envelope: object): void {
  allWsInstances.forEach((ws) => ws.push(envelope));
}

const SESSION_1 = {
  sessionId: "s1",
  token: "tok-1",
  title: "CPU spike on web-01",
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
};

function setup(pendingCount = 0) {
  latestWs = null;
  allWsInstances.length = 0;

  vi.stubGlobal("WebSocket", MockWs);

  const makePending = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `appr-${i}`,
      incidentId: `inc-${i}`,
      sessionId: `s-${i}`,
      token: "tok-1",
      toolName: "restart_service",
      toolInput: {},
      toolUseId: `tool-${i}`,
      status: "pending",
      createdAt: new Date().toISOString(),
    }));

  // Mutable so a test can change the server-side count before broadcasting a WS
  // event; the count derives from this list (refetched on the event), not a delta.
  let pendingApprovals = makePending(pendingCount);
  const setPendingCount = (n: number): void => {
    pendingApprovals = makePending(n);
  };

  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes("/auth/status")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ownerExists: true,
            authenticated: true,
            email: OWNER_EMAIL,
          }),
      });
    }
    if (url.includes("/sessions/pending-human-input")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(pendingApprovals),
      });
    }
    if (url.includes("/chat")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ sessionId: "new-s1" }),
      });
    }
    if (/\/sessions\/[^?]+/.test(url)) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      });
    }
    if (url.includes("/sessions")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([SESSION_1]),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const rootRoute = createRootRoute({ component: ShellLayout });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <SessionView />,
  });
  const sessionIdRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/$id",
    component: function SessionRoute() {
      const { id } = sessionIdRoute.useParams();
      return <SessionView sessionId={id} />;
    },
  });
  const fleetRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/fleet",
    component: () => <div>Fleet Page</div>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <SessionView />,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      sessionIdRoute,
      fleetRoute,
      settingsRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <ConsoleWsProvider>
            <RouterProvider router={router} />
          </ConsoleWsProvider>
        </AuthProvider>
      </QueryClientProvider>
    </TestProviders>,
  );

  return { router, qc, fetchMock, setPendingCount };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// The shadcn Sidebar exposes its collapsed/expanded state on the container via
// data-state; text labels hide purely through CSS, which jsdom does not apply,
// so the collapse contract is asserted through this attribute and the toggle's
// accessible name rather than label visibility.
function sidebarState(): string | null {
  return (
    document
      .querySelector('[data-slot="sidebar"]')
      ?.getAttribute("data-state") ?? null
  );
}

describe("Shell", () => {
  describe("sidebar collapsible rail", () => {
    it("collapsing writes false to localStorage", async () => {
      const user = userEvent.setup();
      setup();

      await waitFor(() =>
        screen.getByRole("button", { name: /collapse sidebar/i }),
      );
      await user.click(
        screen.getByRole("button", { name: /collapse sidebar/i }),
      );

      await waitFor(() =>
        expect(window.localStorage.getItem("nw:sidebar-expanded")).toBe(
          "false",
        ),
      );
    });

    it("expanding after collapse writes true to localStorage", async () => {
      const user = userEvent.setup();
      setup();

      await waitFor(() =>
        screen.getByRole("button", { name: /collapse sidebar/i }),
      );
      await user.click(
        screen.getByRole("button", { name: /collapse sidebar/i }),
      );
      await waitFor(() =>
        screen.getByRole("button", { name: /expand sidebar/i }),
      );
      await user.click(screen.getByRole("button", { name: /expand sidebar/i }));

      await waitFor(() =>
        expect(window.localStorage.getItem("nw:sidebar-expanded")).toBe("true"),
      );
    });

    it("starts collapsed when localStorage has false", async () => {
      window.localStorage.setItem("nw:sidebar-expanded", "false");
      setup();

      await waitFor(() => {
        // Restores the collapsed rail from the persisted preference; the toggle
        // offers to expand and links stay reachable.
        expect(sidebarState()).toBe("collapsed");
        expect(
          screen.getByRole("button", { name: /expand sidebar/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("link", { name: /fleet/i }),
        ).toBeInTheDocument();
      });
    });

    it("New session button navigates to home", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      // Navigate away to /fleet first
      await waitFor(() => screen.getByRole("link", { name: /fleet/i }));
      await user.click(screen.getByRole("link", { name: /fleet/i }));
      await waitFor(() =>
        expect(router.state.location.pathname).toBe("/fleet"),
      );

      // Click New session
      const newSessionBtn = screen.getByRole("button", {
        name: /new session/i,
      });
      await user.click(newSessionBtn);

      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    });

    it("Log out is reachable via icon button in rail mode", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();

      // Collapse
      await waitFor(() =>
        screen.getByRole("button", { name: /collapse sidebar/i }),
      );
      await user.click(
        screen.getByRole("button", { name: /collapse sidebar/i }),
      );

      // Logout button still present (aria-label)
      const logoutBtn = await screen.findByRole("button", {
        name: /log out/i,
      });
      await user.click(logoutBtn);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/logout",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });
  });

  describe("session creation flow", () => {
    it("submitting from home navigates to /sessions/:id", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      const textarea = await screen.findByRole("textbox");
      await user.type(textarea, "Check disk usage on prod");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/sessions/new-s1");
      });
    });

    it("does not create a new WS connection on navigation (no remount)", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await screen.findByRole("textbox");
      const wsAtHome = latestWs;
      expect(wsAtHome).not.toBeNull();

      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/sessions/new-s1");
      });

      // Same WS instance = no remount of the session view
      expect(latestWs).toBe(wsAtHome);
      // Chat input still present
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("captures WS deltas arriving after session creation", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await screen.findByRole("textbox");

      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/sessions/new-s1");
      });

      act(() => {
        broadcast({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: {
            sessionId: "new-s1",
            kind: "text",
            delta: "Analyzing disk usage...",
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("Analyzing disk usage...")).toBeInTheDocument();
      });
    });
  });

  describe("attention queue", () => {
    it("refetches and grows the count when INTERRUPT arrives", async () => {
      const { setPendingCount } = setup(1);
      await waitFor(() => {
        expect(
          screen.getByRole("status", { name: /awaiting approval/i }),
        ).toHaveTextContent("1");
      });

      // The interrupt is now durable server-side; the event triggers a refetch
      // of the authoritative pending list rather than a local +1.
      setPendingCount(2);
      act(() => {
        broadcast({
          messageId: "m-int",
          type: "HUMAN_INPUT_REQUIRED",
          payload: {
            sessionId: "s1",
            toolUseId: "tool-99",
            toolName: "restart_service",
            input: {},
            incidentId: "inc-99",
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.getByRole("status", { name: /awaiting approval/i }),
        ).toHaveTextContent("2");
      });
    });

    it("refetches and clears the count when INTERRUPT_RESOLVED arrives", async () => {
      const { setPendingCount } = setup(1);
      await waitFor(() => {
        expect(
          screen.getByRole("status", { name: /awaiting approval/i }),
        ).toHaveTextContent("1");
      });

      setPendingCount(0);
      act(() => {
        broadcast({
          messageId: "m-res",
          type: "HUMAN_INPUT_RESOLVED",
          payload: {
            incidentId: "inc-0",
            toolUseId: "tool-0",
            status: "approved",
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.queryByRole("status", { name: /awaiting approval/i }),
        ).not.toBeInTheDocument();
      });
    });

    it("does not double-count after an independent refetch (no stale delta)", async () => {
      const { qc, setPendingCount } = setup(1);
      await waitFor(() => {
        expect(
          screen.getByRole("status", { name: /awaiting approval/i }),
        ).toHaveTextContent("1");
      });

      // Server count grows to 2; the event refreshes the list to 2.
      setPendingCount(2);
      act(() => {
        broadcast({
          messageId: "m-int",
          type: "HUMAN_INPUT_REQUIRED",
          payload: {
            sessionId: "s1",
            toolUseId: "tool-99",
            toolName: "restart_service",
            input: {},
            incidentId: "inc-99",
          },
        });
      });
      await waitFor(() => {
        expect(
          screen.getByRole("status", { name: /awaiting approval/i }),
        ).toHaveTextContent("2");
      });

      // An unrelated refetch must not re-apply the event on top of the already
      // up to date list; the count stays 2, not 3.
      await act(async () => {
        await qc.invalidateQueries({
          queryKey: ["sessions-pending-human-input"],
        });
      });
      await waitFor(() => {
        expect(
          screen.getByRole("status", { name: /awaiting approval/i }),
        ).toHaveTextContent("2");
      });
    });
  });

  describe("account", () => {
    it("Log out posts /api/logout", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();

      const logoutButton = await screen.findByRole("button", {
        name: /log out/i,
      });
      await user.click(logoutButton);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/logout",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });
  });
});
