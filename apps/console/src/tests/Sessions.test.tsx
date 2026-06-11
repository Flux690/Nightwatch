import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { RouterProvider } from "@tanstack/react-router";

import { SessionsSidebar, NewSessionPage } from "../pages/Sessions.js";
import { theme, cssVariablesResolver } from "../theme.js";

let latestWs: MockWs | null = null;

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
  }

  push(envelope: object): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }
}

const RUNNER = {
  id: "inst-1",
  token: "tok-1",
  hostname: "host-1",
  online: true,
  createdAt: "2024-01-01T00:00:00Z",
};

const SESSION_1 = {
  sessionId: "s1",
  token: "tok-1",
  trigger: "alert",
  title: "CPU spike on web-01",
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 min ago
};

function setupWithSessionsError() {
  latestWs = null;

  vi.stubGlobal("WebSocket", MockWs);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.includes("/runners")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([RUNNER]),
        });
      }
      if (url.includes("/sessions")) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.resolve({ error: "no runner connected" }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }),
  );

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const root = createRootRoute({ component: Outlet });
  const sessionsRoute = createRoute({
    getParentRoute: () => root,
    path: "/sessions",
    component: SessionsSidebar,
  });
  const router = createRouter({
    routeTree: root.addChildren([sessionsRoute]),
    history: createMemoryHistory({ initialEntries: ["/sessions"] }),
  });

  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

function setup(sessions: object[] = [SESSION_1]) {
  latestWs = null;

  vi.stubGlobal("WebSocket", MockWs);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.includes("/runners")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([RUNNER]),
        });
      }
      if (url.includes("/sessions")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(sessions),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }),
  );

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const root = createRootRoute({ component: Outlet });
  const sessionsRoute = createRoute({
    getParentRoute: () => root,
    path: "/sessions",
    component: SessionsSidebar,
  });
  const sessionIdRoute = createRoute({
    getParentRoute: () => root,
    path: "/sessions/$id",
    component: () => <div data-testid="transcript" />,
  });
  const newSessionRoute = createRoute({
    getParentRoute: () => root,
    path: "/sessions/new",
    component: () => <div data-testid="new-session-page" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      sessionsRoute,
      sessionIdRoute,
      newSessionRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/sessions"] }),
  });

  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>,
  );

  return { router };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SessionsSidebar", () => {
  describe("initial render", () => {
    it("renders an empty list when the sessions endpoint returns an error", async () => {
      setupWithSessionsError();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /new session/i }),
        ).toBeInTheDocument();
      });
      expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    });

    it("fetches sessions and renders a row for each", async () => {
      setup();

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });
    });

    it("shows a relative timestamp on each row", async () => {
      setup();

      await waitFor(() => {
        expect(screen.getByText(/ago/i)).toBeInTheDocument();
      });
    });

    it("shows a 'concluded' badge for a session with no live activity", async () => {
      setup();

      await waitFor(() => {
        expect(screen.getByText("concluded")).toBeInTheDocument();
      });
    });

    it("renders a New Session button", async () => {
      setup();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /new session/i }),
        ).toBeInTheDocument();
      });
    });
  });

  describe("live WS updates", () => {
    it("updates the status badge to 'streaming' on TEXT_MESSAGE_CONTENT for existing session", async () => {
      setup();

      await waitFor(() => {
        expect(screen.getByText("concluded")).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m1",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Analyzing..." },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("streaming")).toBeInTheDocument();
      });
    });

    it("updates the badge to 'awaiting-approval' on INTERRUPT", async () => {
      setup();

      await waitFor(() => {
        expect(screen.getByText("concluded")).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m2",
          type: "INTERRUPT",
          payload: {
            sessionId: "s1",
            toolUseId: "tu1",
            toolName: "restart_service",
            input: {},
            incidentId: "inc-1",
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("awaiting-approval")).toBeInTheDocument();
      });
    });

    it("resets badge to 'concluded' on RUN_FINISHED for existing session", async () => {
      setup();

      await waitFor(() => {
        expect(screen.getByText("concluded")).toBeInTheDocument();
      });

      // First make it streaming
      act(() => {
        latestWs?.push({
          messageId: "m3",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s1", kind: "text", delta: "Thinking..." },
        });
      });
      await waitFor(() =>
        expect(screen.getByText("streaming")).toBeInTheDocument(),
      );

      // Then finish turn
      act(() => {
        latestWs?.push({
          messageId: "m4",
          type: "RUN_FINISHED",
          payload: {
            sessionId: "s1",
            message: {
              sessionId: "s1",
              seq: 1,
              role: "assistant",
              content: "Done",
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getByText("concluded")).toBeInTheDocument();
      });
    });

    it("appends a new row when RUN_FINISHED arrives for an unseen sessionId", async () => {
      setup([SESSION_1]);

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });

      // Initially one session row
      expect(screen.getAllByRole("listitem")).toHaveLength(1);

      act(() => {
        latestWs?.push({
          messageId: "m5",
          type: "RUN_FINISHED",
          payload: {
            sessionId: "s-new",
            message: {
              sessionId: "s-new",
              seq: 1,
              role: "assistant",
              content: "Investigation started",
              createdAt: new Date().toISOString(),
            },
          },
        });
      });

      await waitFor(() => {
        expect(screen.getAllByRole("listitem")).toHaveLength(2);
      });
    });

    it("appends a new row when TEXT_MESSAGE_CONTENT arrives for an unseen sessionId", async () => {
      setup([SESSION_1]);

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });

      act(() => {
        latestWs?.push({
          messageId: "m6",
          type: "TEXT_MESSAGE_CONTENT",
          payload: { sessionId: "s-brand-new", kind: "text", delta: "..." },
        });
      });

      await waitFor(() => {
        expect(screen.getAllByRole("listitem")).toHaveLength(2);
      });
    });
  });

  describe("NewSessionPage", () => {
    function setupNewSession() {
      vi.stubGlobal("WebSocket", MockWs);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          if (url.includes("/runners")) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve([RUNNER]),
            });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ sessionId: "created-id" }),
          });
        }),
      );

      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });

      const root = createRootRoute({ component: Outlet });
      const newRoute = createRoute({
        getParentRoute: () => root,
        path: "/sessions/new",
        component: NewSessionPage,
      });
      const sessionIdRoute = createRoute({
        getParentRoute: () => root,
        path: "/sessions/$id",
        component: () => <div>session transcript</div>,
      });
      const router = createRouter({
        routeTree: root.addChildren([newRoute, sessionIdRoute]),
        history: createMemoryHistory({ initialEntries: ["/sessions/new"] }),
      });

      render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="light"
        >
          <QueryClientProvider client={qc}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </MantineProvider>,
      );

      return { fetchMock: vi.mocked(fetch) };
    }

    it("renders an enabled composer with no transcript content", async () => {
      setupNewSession();

      const textarea = await screen.findByRole("textbox");
      const button = screen.getByRole("button", { name: /send/i });

      expect(textarea).not.toBeDisabled();
      expect(button).not.toBeDisabled();
      expect(screen.queryByText(/select a session/i)).not.toBeInTheDocument();
    });

    it("submits to POST /api/chat/:token and navigates to the new session", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setupNewSession();

      const textarea = await screen.findByRole("textbox");
      await user.type(textarea, "Check disk usage on prod");
      await user.click(screen.getByRole("button", { name: /send/i }));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/chat/tok-1",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ message: "Check disk usage on prod" }),
        }),
      );

      await screen.findByText("session transcript");
    });
  });

  describe("navigation", () => {
    it("navigates to /sessions/:id when a session row is clicked", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByText("CPU spike on web-01"));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/sessions/s1");
      });
    });

    it("navigates to /sessions/new when New Session is clicked", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /new session/i }),
        ).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /new session/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/sessions/new");
      });
    });
  });
});
