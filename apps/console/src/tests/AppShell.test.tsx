import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
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
import { ConsoleEventsProvider } from "@/hooks/ConsoleEventsProvider";
import { Shell } from "@/components/layout/Shell";
import { SessionView } from "@/pages/SessionView";
import { MockEventSource } from "./mockEventSource.js";

function ShellLayout(): React.JSX.Element {
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

const OWNER_EMAIL = "admin@example.com";

const SESSION_1 = {
  sessionId: "s1",
  token: "tok-1",
  title: "CPU spike on web-01",
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
};

function setup(pendingCount = 0) {
  MockEventSource.reset();

  vi.stubGlobal("EventSource", MockEventSource);

  const makePending = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `appr-${i}`,
      incidentId: `inc-${i}`,
      sessionId: `s-${i}`,
      token: "tok-1",
      toolName: "RestartDockerService",
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

  // Mutable report: null = conversation (404), set = investigation (morph).
  let sessionReport: Record<string, unknown> | null = null;
  const setSessionReport = (r: Record<string, unknown> | null): void => {
    sessionReport = r;
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
    if (url.includes("/runners")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.includes("/integrations/")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ configured: false, lastReceivedAt: null }),
      });
    }
    if (url.includes("/report")) {
      return sessionReport === null
        ? Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ error: "no report for session" }),
          })
        : Promise.resolve({
            ok: true,
            json: () => Promise.resolve(sessionReport),
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
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations Page</div>,
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
      integrationsRoute,
      settingsRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <ConsoleEventsProvider>
            <RouterProvider router={router} />
          </ConsoleEventsProvider>
        </AuthProvider>
      </QueryClientProvider>
    </TestProviders>,
  );

  return { router, qc, fetchMock, setPendingCount, setSessionReport };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// The icon rail is always present; only the list rail collapses. Its presence
// is the expanded/collapsed signal (jsdom applies no CSS, so we test the DOM).
function listRailPresent(): boolean {
  return document.querySelector('[data-slot="list-rail"]') !== null;
}

// The list rail has no on-screen toggle: cmd/ctrl+B is the only control, handled
// by a window keydown listener.
function pressToggleShortcut(): void {
  fireEvent.keyDown(document.body, { key: "b", metaKey: true });
}

describe("Shell", () => {
  describe("list rail collapse (icon rail always visible)", () => {
    it("cmd+B collapses only the list rail and writes false to localStorage", async () => {
      setup();

      await screen.findByRole("link", { name: /integrations/i });
      expect(listRailPresent()).toBe(true);

      pressToggleShortcut();

      await waitFor(() =>
        expect(window.localStorage.getItem("nw:sidebar-expanded")).toBe(
          "false",
        ),
      );
      // The list rail is gone entirely; the icon rail is untouched.
      expect(listRailPresent()).toBe(false);
      expect(
        screen.getByRole("link", { name: /integrations/i }),
      ).toBeInTheDocument();
    });

    it("cmd+B again reopens the list rail and writes true to localStorage", async () => {
      setup();

      await screen.findByRole("link", { name: /integrations/i });
      pressToggleShortcut();
      await waitFor(() => expect(listRailPresent()).toBe(false));
      pressToggleShortcut();

      await waitFor(() =>
        expect(window.localStorage.getItem("nw:sidebar-expanded")).toBe("true"),
      );
      expect(listRailPresent()).toBe(true);
    });

    it("starts collapsed when localStorage has false", async () => {
      window.localStorage.setItem("nw:sidebar-expanded", "false");
      setup();

      await waitFor(() => {
        // The list rail is hidden entirely; the icon rail's links stay reachable.
        expect(
          screen.getByRole("link", { name: /integrations/i }),
        ).toBeInTheDocument();
      });
      expect(listRailPresent()).toBe(false);
    });

    it("New session button navigates to home", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      // Navigate away to /integrations first
      await waitFor(() => screen.getByRole("link", { name: /integrations/i }));
      await user.click(screen.getByRole("link", { name: /integrations/i }));
      await waitFor(() =>
        expect(router.state.location.pathname).toBe("/integrations"),
      );

      // Click New session
      const newSessionBtn = screen.getByRole("button", {
        name: /new session/i,
      });
      await user.click(newSessionBtn);

      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    });

    it("Log out lives in the always-visible icon rail", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();

      // No collapse needed: the icon rail (and its Log out) is always present.
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

    it("does not create a new event stream on navigation (no remount)", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await screen.findByRole("textbox");
      const streamAtHome = MockEventSource.latest;
      expect(streamAtHome).not.toBeNull();

      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/sessions/new-s1");
      });

      // Same stream instance = no remount of the session view
      expect(MockEventSource.latest).toBe(streamAtHome);
      // Chat input still present
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("morphs to the investigation layout without remounting the chat", async () => {
      const user = userEvent.setup();
      const { router, setSessionReport } = setup();

      await screen.findByRole("textbox");
      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/sessions/new-s1");
      });
      const streamBefore = MockEventSource.latest;

      // The agent's first UpdateReport: the report row now exists and the
      // console hears REPORT_UPDATED - chat moves to the rail, report to main.
      setSessionReport({
        status: "investigation_incomplete",
        headline: "web-01 memory leak",
        rootCause: { summary: "", detail: "" },
        hypotheses: [],
        evidence: [],
        proposedFix: { summary: "", steps: [], evidenceIds: [] },
        updatedAt: new Date().toISOString(),
        model: "test",
      });
      act(() => {
        MockEventSource.broadcast({
          messageId: "m-rep",
          type: "REPORT_UPDATED",
          payload: { sessionId: "new-s1" },
        });
      });

      await waitFor(() => {
        expect(
          screen.getByRole("complementary", { name: /investigation chat/i }),
        ).toBeInTheDocument();
        expect(screen.getByText("web-01 memory leak")).toBeInTheDocument();
      });

      // The morph is a DOM re-parent, never a remount: same stream, same input.
      expect(MockEventSource.latest).toBe(streamBefore);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("captures deltas arriving after session creation", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await screen.findByRole("textbox");

      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/sessions/new-s1");
      });

      act(() => {
        MockEventSource.broadcast({
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
        MockEventSource.broadcast({
          messageId: "m-int",
          type: "HUMAN_INPUT_REQUIRED",
          payload: {
            sessionId: "s1",
            toolUseId: "tool-99",
            toolName: "RestartDockerService",
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
        MockEventSource.broadcast({
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
        MockEventSource.broadcast({
          messageId: "m-int",
          type: "HUMAN_INPUT_REQUIRED",
          payload: {
            sessionId: "s1",
            toolUseId: "tool-99",
            toolName: "RestartDockerService",
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
