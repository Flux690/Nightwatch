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
} from "@tanstack/react-router";
import { RouterProvider } from "@tanstack/react-router";

import { AuthProvider } from "../auth/AuthContext.js";
import { Shell } from "../pages/Shell.js";
import { theme, cssVariablesResolver } from "../theme.js";

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

  const pendingApprovals = Array.from({ length: pendingCount }, (_, i) => ({
    id: `appr-${i}`,
    incidentId: `inc-${i}`,
    sessionId: `s-${i}`,
    token: "tok-1",
    toolName: "restart_container",
    toolInput: {},
    toolUseId: `tool-${i}`,
    status: "pending",
    createdAt: new Date().toISOString(),
  }));

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

  const rootRoute = createRootRoute({ component: Shell });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const sessionIdRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/sessions/$id",
    component: () => null,
  });
  const fleetRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/fleet",
    component: () => <div>Fleet Page</div>,
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: () => <div>Settings Page</div>,
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
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );

  return { router, qc, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Shell", () => {
  describe("nav + sidebar structure", () => {
    it("renders nav links for Fleet and Settings", async () => {
      setup();
      await waitFor(() => {
        expect(
          screen.getByRole("link", { name: /fleet/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("link", { name: /settings/i }),
        ).toBeInTheDocument();
      });
    });

    it("renders the sessions sidebar with existing session rows", async () => {
      setup();
      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });
    });

    it("sidebar rows show title and relative time but no status badge", async () => {
      setup();
      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
        expect(screen.getByText(/ago/i)).toBeInTheDocument();
      });
      expect(screen.queryByText("concluded")).not.toBeInTheDocument();
      expect(screen.queryByText("streaming")).not.toBeInTheDocument();
      expect(screen.queryByText("awaiting-approval")).not.toBeInTheDocument();
    });
  });

  describe("sidebar collapsible rail", () => {
    it("the standalone Sessions nav link is absent", async () => {
      setup();
      // Wait for the sidebar to be fully mounted
      await waitFor(() =>
        expect(
          screen.getByRole("link", { name: /fleet/i }),
        ).toBeInTheDocument(),
      );
      // There should be no link whose accessible name is exactly "Sessions"
      expect(
        screen.queryByRole("link", { name: "Sessions" }),
      ).not.toBeInTheDocument();
    });

    it("New session button is present in expanded view", async () => {
      setup();
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /new session/i }),
        ).toBeInTheDocument();
      });
    });

    it("Recent sessions heading and session list are present in expanded view", async () => {
      setup();
      await waitFor(() => {
        expect(screen.getByText(/recent sessions/i)).toBeInTheDocument();
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });
    });

    it("owner email and Log out button are present in expanded view", async () => {
      setup();
      await waitFor(() => {
        expect(screen.getByText(OWNER_EMAIL)).toBeInTheDocument();
        expect(
          screen.getByRole("button", { name: /log out/i }),
        ).toBeInTheDocument();
      });
    });

    it("toggle collapses sidebar: text labels disappear and links remain accessible via aria-label", async () => {
      const user = userEvent.setup();
      setup();

      // Start expanded: text labels visible
      await waitFor(() => {
        expect(screen.getByText("Fleet")).toBeInTheDocument();
        expect(screen.getByText("Settings")).toBeInTheDocument();
      });

      // Collapse
      await user.click(
        screen.getByRole("button", { name: /collapse sidebar/i }),
      );

      await waitFor(() => {
        // Text labels gone
        expect(screen.queryByText("Fleet")).not.toBeInTheDocument();
        expect(screen.queryByText("Settings")).not.toBeInTheDocument();
        // Links still accessible via aria-label
        expect(
          screen.getByRole("link", { name: /fleet/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("link", { name: /settings/i }),
        ).toBeInTheDocument();
        // Session list hidden
        expect(screen.queryByText(/recent sessions/i)).not.toBeInTheDocument();
      });
    });

    it("toggle expands sidebar: text labels reappear", async () => {
      const user = userEvent.setup();
      setup();

      // Collapse first
      await waitFor(() =>
        screen.getByRole("button", { name: /collapse sidebar/i }),
      );
      await user.click(
        screen.getByRole("button", { name: /collapse sidebar/i }),
      );

      // Verify collapsed
      await waitFor(() =>
        expect(screen.queryByText("Fleet")).not.toBeInTheDocument(),
      );

      // Expand again
      await user.click(screen.getByRole("button", { name: /expand sidebar/i }));

      await waitFor(() => {
        expect(screen.getByText("Fleet")).toBeInTheDocument();
        expect(screen.getByText("Settings")).toBeInTheDocument();
        expect(screen.getByText(/recent sessions/i)).toBeInTheDocument();
      });
    });

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
        // In collapsed state labels are absent
        expect(screen.queryByText("Fleet")).not.toBeInTheDocument();
        expect(screen.queryByText(/recent sessions/i)).not.toBeInTheDocument();
        // But links are still accessible
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

  describe("home route (/)", () => {
    it("shows a chat input at /", async () => {
      setup();
      const textarea = await screen.findByRole("textbox");
      expect(textarea).toBeInTheDocument();
      expect(textarea).not.toBeDisabled();
    });

    it("does not redirect / to /sessions", async () => {
      const { router } = setup();
      await screen.findByRole("textbox");
      expect(router.state.location.pathname).toBe("/");
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

    it("new session appears in sidebar after creation", async () => {
      const user = userEvent.setup();
      setup();

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });

      const initialCount = screen.getAllByRole("listitem").length;

      const textarea = await screen.findByRole("textbox");
      await user.type(textarea, "Check disk usage");
      await user.click(screen.getByRole("button", { name: /send/i }));

      await waitFor(() => {
        expect(screen.getAllByRole("listitem")).toHaveLength(initialCount + 1);
      });
    });
  });

  describe("nav link routing", () => {
    it("clicking Fleet nav link shows fleet content", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await waitFor(() => {
        expect(
          screen.getByRole("link", { name: /fleet/i }),
        ).toBeInTheDocument();
      });

      await user.click(screen.getByRole("link", { name: /fleet/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/fleet");
      });
    });

    it("clicking Settings nav link shows settings content", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await waitFor(() => {
        expect(
          screen.getByRole("link", { name: /settings/i }),
        ).toBeInTheDocument();
      });

      await user.click(screen.getByRole("link", { name: /settings/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/settings");
      });
    });
  });

  describe("attention queue", () => {
    it("shows awaiting-approval count on first load from API", async () => {
      setup(2);
      await waitFor(() => {
        expect(
          screen.getByRole("status", { name: /awaiting approval/i }),
        ).toHaveTextContent("2");
      });
    });

    it("increments count when INTERRUPT arrives", async () => {
      setup(1);
      await waitFor(() => {
        expect(
          screen.getByRole("status", { name: /awaiting approval/i }),
        ).toHaveTextContent("1");
      });

      act(() => {
        broadcast({
          messageId: "m-int",
          type: "HUMAN_INPUT_REQUIRED",
          payload: {
            sessionId: "s1",
            toolUseId: "tool-99",
            toolName: "restart_container",
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

    it("decrements count when INTERRUPT_RESOLVED arrives", async () => {
      setup(1);
      await waitFor(() => {
        expect(
          screen.getByRole("status", { name: /awaiting approval/i }),
        ).toHaveTextContent("1");
      });

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

    it("shows no indicator when count is zero", async () => {
      setup(0);
      await screen.findByRole("link", { name: /fleet/i });
      expect(
        screen.queryByRole("status", { name: /awaiting approval/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe("account", () => {
    it("shows the logged-in operator's email", async () => {
      setup();
      await waitFor(() => {
        expect(screen.getByText(OWNER_EMAIL)).toBeInTheDocument();
      });
    });

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
