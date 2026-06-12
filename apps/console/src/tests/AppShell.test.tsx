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

import { Shell } from "../pages/Shell.js";
import { theme, cssVariablesResolver } from "../theme.js";

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
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
};

function setup(pendingCount = 0) {
  latestWs = null;
  allWsInstances.length = 0;

  vi.stubGlobal("WebSocket", MockWs);

  const pendingApprovals = Array.from({ length: pendingCount }, (_, i) => ({
    id: `appr-${i}`,
    incidentId: `inc-${i}`,
    token: "tok-1",
    toolName: "restart_container",
    toolInput: {},
    toolUseId: `tool-${i}`,
    status: "pending",
    createdAt: new Date().toISOString(),
  }));

  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.includes("/runners")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([RUNNER]),
        });
      }
      if (url.includes("/approvals/pending")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(pendingApprovals),
        });
      }
      if (url.includes("/chat/")) {
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
    }),
  );

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
  const runnersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/runners",
    component: () => <div>Runners Page</div>,
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
      runnersRoute,
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
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProvider>,
  );

  return { router, qc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Shell", () => {
  describe("nav + sidebar structure", () => {
    it("renders nav links for Sessions, Runners, and Settings", async () => {
      setup();
      await waitFor(() => {
        expect(
          screen.getByRole("link", { name: /sessions/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("link", { name: /runners/i }),
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
    it("clicking Runners nav link shows runners content", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await waitFor(() => {
        expect(
          screen.getByRole("link", { name: /runners/i }),
        ).toBeInTheDocument();
      });

      await user.click(screen.getByRole("link", { name: /runners/i }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/runners");
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
          type: "INTERRUPT",
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
          type: "INTERRUPT_RESOLVED",
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
      await screen.findByRole("link", { name: /sessions/i });
      expect(
        screen.queryByRole("status", { name: /awaiting approval/i }),
      ).not.toBeInTheDocument();
    });
  });
});
