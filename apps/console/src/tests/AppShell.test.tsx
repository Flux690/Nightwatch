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
  title: "CPU spike on web-01",
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  investigation: false,
  severity: null,
  status: null,
  awaitingHumanInput: false,
};

function setup(pendingCount = 0) {
  MockEventSource.reset();

  vi.stubGlobal("EventSource", MockEventSource);

  // Waiting sessions are ordinary session rows carrying the flag - the badge counts
  // the list, so there is no second endpoint that can disagree with it.
  const makePending = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: `s-${i}`,
      title: `Waiting session ${i}`,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      investigation: true,
      severity: null,
      target: null,
      status: "action_required",
      awaitingHumanInput: true,
    }));

  // Mutable so a test can change the server-side count before broadcasting a WS
  // event; the count derives from this list (refetched on the event), not a delta.
  let pendingApprovals = makePending(pendingCount);
  const setPendingCount = (n: number): void => {
    pendingApprovals = makePending(n);
  };

  // The report is a finding the agent may not have recorded yet; null = 404.
  // It no longer decides the layout, so a test can set either independently.
  let sessionReport: Record<string, unknown> | null = null;
  const setSessionReport = (r: Record<string, unknown> | null): void => {
    sessionReport = r;
  };

  // What the session says it is. This is what the layout keys on.
  let investigation = false;
  const setInvestigation = (value: boolean): void => {
    investigation = value;
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
            json: () =>
              Promise.resolve({
                report: sessionReport,
                actions: [],
                evidence: [],
                conviction: {},
              }),
          });
    }
    if (/\/sessions\/[^?]+/.test(url)) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            sessionId: "new-s1",
            title: "Check disk",
            createdAt: "2026-06-13T00:00:00.000Z",
            investigation,
            originatingAlert: null,
            transcript: [],
          }),
      });
    }
    if (url.includes("/sessions")) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            rows: [SESSION_1, ...pendingApprovals],
            nextOffset: null,
          }),
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

  return {
    router,
    qc,
    fetchMock,
    setPendingCount,
    setSessionReport,
    setInvestigation,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// jsdom applies no CSS, so the sessions zone leaves the DOM when the sidebar
// collapses rather than being hidden by a class - which is also what makes
// "collapsed shows destinations only" a fact a test can check.
function sessionListPresent(): boolean {
  return screen.queryByText("CPU spike on web-01") !== null;
}

function precedes(a: HTMLElement, b: HTMLElement): boolean {
  return (
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  );
}

describe("Shell", () => {
  describe("the one sidebar", () => {
    it("renders three zones in order: destinations, sessions, account", async () => {
      setup();

      const newSession = await screen.findByRole("button", {
        name: /new session/i,
      });
      const sessionsHeading = screen.getByText("Sessions");
      const settings = screen.getByRole("button", { name: /settings/i });
      const logOut = screen.getByRole("button", { name: /log out/i });
      const integrations = screen.getByRole("link", { name: /integrations/i });
      const audit = screen.getByRole("link", { name: /audit log/i });

      expect(precedes(newSession, integrations)).toBe(true);
      expect(precedes(audit, sessionsHeading)).toBe(true);
      expect(precedes(sessionsHeading, settings)).toBe(true);
      expect(precedes(settings, logOut)).toBe(true);
    });

    it("shows every destination with a visible label", async () => {
      setup();

      for (const label of ["New session", "Integrations", "Audit log"]) {
        expect(await screen.findByText(label)).toBeInTheDocument();
      }
    });

    it("collapsing leaves the destinations reachable and drops the sessions", async () => {
      const user = userEvent.setup();
      setup();

      await waitFor(() => expect(sessionListPresent()).toBe(true));

      await user.click(screen.getByRole("button", { name: /toggle sidebar/i }));

      await waitFor(() => expect(sessionListPresent()).toBe(false));
      expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
      // Every destination is still there, and still named for assistive tech.
      expect(
        screen.getByRole("link", { name: /integrations/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /audit log/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /new session/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /log out/i }),
      ).toBeInTheDocument();
    });

    it("expanding again brings the sessions back", async () => {
      const user = userEvent.setup();
      setup();

      await waitFor(() => expect(sessionListPresent()).toBe(true));
      const toggle = screen.getByRole("button", { name: /toggle sidebar/i });

      await user.click(toggle);
      await waitFor(() => expect(sessionListPresent()).toBe(false));
      await user.click(toggle);

      await waitFor(() => expect(sessionListPresent()).toBe(true));
    });

    it("New session button navigates to home", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await waitFor(() => screen.getByRole("link", { name: /integrations/i }));
      await user.click(screen.getByRole("link", { name: /integrations/i }));
      await waitFor(() =>
        expect(router.state.location.pathname).toBe("/integrations"),
      );

      await user.click(screen.getByRole("button", { name: /new session/i }));

      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
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

    // The layout follows what the session says it is, so it appears with no
    // report row present - which is the state an alert-opened session is in
    // for the whole of the first minute.
    it("morphs to the investigation layout on the session's own flag, with no report", async () => {
      const user = userEvent.setup();
      const { router, setInvestigation } = setup();

      await screen.findByRole("textbox");
      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/sessions/new-s1");
      });
      const streamBefore = MockEventSource.latest;

      // The agent called OpenInvestigation; its turn lands and the console
      // refetches the session.
      setInvestigation(true);
      act(() => {
        MockEventSource.broadcast({
          messageId: "m-1",
          type: "MESSAGE",
          payload: {
            sessionId: "new-s1",
            message: {
              role: "assistant",
              content: "Opening an investigation.",
            },
          },
        });
      });

      await waitFor(() => {
        expect(
          screen.getByRole("complementary", { name: /investigation chat/i }),
        ).toBeInTheDocument();
      });
      // No report row exists, and the panel says so rather than rendering blank.
      expect(
        screen.getByText(/has not recorded a finding yet/i),
      ).toBeInTheDocument();

      // The morph is a DOM re-parent, never a remount: same stream, same input.
      expect(MockEventSource.latest).toBe(streamBefore);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("renders the report in the investigation layout once one exists", async () => {
      const user = userEvent.setup();
      const { router, setInvestigation, setSessionReport } = setup();

      await screen.findByRole("textbox");
      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/sessions/new-s1");
      });

      setInvestigation(true);
      setSessionReport({
        hypotheses: [
          {
            id: "h1",
            statement: "web-01 leaks memory",
            verdict: "root_cause",
            finding: "",
            evidenceIds: [],
            proposedAt: new Date().toISOString(),
            resolvedAt: new Date().toISOString(),
          },
        ],
        fixes: [],
        updatedAt: new Date().toISOString(),
        model: "test",
      });
      act(() => {
        MockEventSource.broadcast({
          messageId: "m-1",
          type: "MESSAGE",
          payload: {
            sessionId: "new-s1",
            message: { role: "assistant", content: "Found it." },
          },
        });
        MockEventSource.broadcast({
          messageId: "m-rep",
          type: "REPORT_UPDATED",
          payload: { sessionId: "new-s1" },
        });
      });

      await waitFor(() => {
        expect(screen.getAllByText("web-01 leaks memory").length).toBe(2);
      });
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

  describe("the chat rail", () => {
    // The toggle is a sibling of the panel, so closing the panel cannot take
    // the control that reopens it with it.
    it("collapses and reopens without interrupting the live stream", async () => {
      const user = userEvent.setup();
      const { router, setInvestigation } = setup();

      await screen.findByRole("textbox");
      await user.type(screen.getByRole("textbox"), "Check disk");
      await user.click(screen.getByRole("button", { name: /send/i }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/sessions/new-s1");
      });

      setInvestigation(true);
      act(() => {
        MockEventSource.broadcast({
          messageId: "m-1",
          type: "MESSAGE",
          payload: {
            sessionId: "new-s1",
            message: {
              role: "assistant",
              content: "Opening an investigation.",
            },
          },
        });
      });
      const railed = await screen.findByRole("complementary", {
        name: /investigation chat/i,
      });
      expect(railed).toBeInTheDocument();
      const streamBefore = MockEventSource.latest;

      await user.click(screen.getByRole("button", { name: /hide the chat/i }));

      await waitFor(() => {
        expect(
          screen.queryByRole("complementary", { name: /investigation chat/i }),
        ).not.toBeInTheDocument();
      });
      const reopen = screen.getByRole("button", { name: /show the chat/i });
      await user.click(reopen);

      await waitFor(() => {
        expect(
          screen.getByRole("complementary", { name: /investigation chat/i }),
        ).toBeInTheDocument();
      });
      // A DOM re-parent throughout: the stream is the same instance.
      expect(MockEventSource.latest).toBe(streamBefore);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
  });

  describe("attention queue", () => {
    it("refetches and grows the count when INTERRUPT arrives", async () => {
      const { setPendingCount } = setup(1);
      await waitFor(() => {
        expect(
          screen.getByRole("link", {
            name: /^1 awaiting approval/,
          }),
        ).toBeInTheDocument();
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
          screen.getByRole("link", {
            name: /^2 awaiting approval/,
          }),
        ).toBeInTheDocument();
      });
    });

    it("refetches and clears the count when INTERRUPT_RESOLVED arrives", async () => {
      const { setPendingCount } = setup(1);
      await waitFor(() => {
        expect(
          screen.getByRole("link", {
            name: /^1 awaiting approval/,
          }),
        ).toBeInTheDocument();
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
          screen.queryByRole("link", { name: /awaiting approval/i }),
        ).not.toBeInTheDocument();
      });
    });

    it("does not double-count after an independent refetch (no stale delta)", async () => {
      const { qc, setPendingCount } = setup(1);
      await waitFor(() => {
        expect(
          screen.getByRole("link", {
            name: /^1 awaiting approval/,
          }),
        ).toBeInTheDocument();
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
          screen.getByRole("link", {
            name: /^2 awaiting approval/,
          }),
        ).toBeInTheDocument();
      });

      // An unrelated refetch must not re-apply the event on top of the already
      // up to date list; the count stays 2, not 3.
      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["sessions"] });
      });
      await waitFor(() => {
        expect(
          screen.getByRole("link", {
            name: /^2 awaiting approval/,
          }),
        ).toBeInTheDocument();
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
