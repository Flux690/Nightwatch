import { render, screen, waitFor } from "@testing-library/react";
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

import { SessionsSidebar } from "@/components/layout/SessionsSidebar";

const RUNNER = {
  id: "inst-1",
  token: "tok-1",
  hostname: "host-1",
  online: true,
  createdAt: "2024-01-01T00:00:00Z",
};

// Investigation rows show on the default tab; conversations on the other.
const SESSION_1 = {
  sessionId: "s1",
  token: "tok-1",
  title: "CPU spike on web-01",
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 min ago
  lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  investigation: true,
  severity: "warning",
  target: "docker:web-01",
  status: "resolved",
  rootCauseLine: "OOM after deploy",
};

const SESSION_2 = {
  sessionId: "s2",
  token: "tok-1",
  title: "Disk full on db-02",
  createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
  lastActivityAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  investigation: true,
  severity: "critical",
  target: "docker:db-02",
  status: "action_required",
  rootCauseLine: null,
};

const CHAT_1 = {
  sessionId: "c1",
  token: "tok-1",
  title: "What does OOM mean?",
  createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 60 * 1000).toISOString(),
  investigation: false,
  severity: null,
  target: null,
  status: null,
  rootCauseLine: null,
};

function setupWithSessionsError() {
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 1;
      onmessage = null;
      onopen = null;
      onclose = null;
      onerror = null;
      close = vi.fn();
      constructor() {}
    },
  );
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
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );
}

function setup(
  sessions: object[] = [SESSION_1],
  deleteOk = true,
  initialPath = "/sessions",
) {
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 1;
      onmessage = null;
      onopen = null;
      onclose = null;
      onerror = null;
      close = vi.fn();
      constructor() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("/runners")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([RUNNER]),
        });
      }
      if (url.includes("/sessions/") && init?.method === "DELETE") {
        return Promise.resolve({
          ok: deleteOk,
          status: deleteOk ? 200 : 500,
          json: () =>
            Promise.resolve(deleteOk ? {} : { error: "delete failed" }),
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

  // Mirrors Shell.tsx: SessionsSidebar mounts once at the layout level, reading
  // the active id via useParams({ strict: false }) instead of being the route's component.
  const root = createRootRoute({
    component: () => (
      <>
        <SessionsSidebar />
        <Outlet />
      </>
    ),
  });
  const sessionsRoute = createRoute({
    getParentRoute: () => root,
    path: "/sessions",
    component: () => null,
  });
  const sessionIdRoute = createRoute({
    getParentRoute: () => root,
    path: "/sessions/$id",
    component: () => <div data-testid="transcript" />,
  });
  const router = createRouter({
    routeTree: root.addChildren([sessionsRoute, sessionIdRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
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

      // Wait for runners to load (sidebar is visible)
      await waitFor(() => {
        expect(screen.queryAllByRole("listitem")).toHaveLength(0);
      });
    });
  });

  describe("delete", () => {
    it("deletes the session when confirmed and removes it from the list", async () => {
      const user = userEvent.setup();
      setup();
      const fetchMock = vi.mocked(fetch);

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /delete session/i }));
      await user.click(
        await screen.findByRole("button", { name: /^delete$/i }),
      );

      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/s1", {
        method: "DELETE",
      });
      await waitFor(() => {
        expect(
          screen.queryByText("CPU spike on web-01"),
        ).not.toBeInTheDocument();
      });
    });

    it("keeps the session in the list when the delete request fails", async () => {
      const user = userEvent.setup();
      setup([SESSION_1], false);

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /delete session/i }));
      await user.click(
        await screen.findByRole("button", { name: /^delete$/i }),
      );

      // The delete is not optimistic: a failed request leaves the row in place
      // (and surfaces an error) rather than dropping it as if it succeeded.
      await waitFor(() => {
        expect(vi.mocked(fetch)).toHaveBeenCalledWith(
          "/api/sessions/s1",
          expect.objectContaining({ method: "DELETE" }),
        );
      });
      expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
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
  });

  describe("tabs", () => {
    it("partitions investigations and conversations across the two tabs", async () => {
      const user = userEvent.setup();
      setup([SESSION_1, CHAT_1]);

      // Default tab: investigations only.
      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });
      expect(screen.queryByText("What does OOM mean?")).not.toBeInTheDocument();

      await user.click(screen.getByRole("tab", { name: /conversations/i }));
      expect(screen.getByText("What does OOM mean?")).toBeInTheDocument();
      expect(screen.queryByText("CPU spike on web-01")).not.toBeInTheDocument();
    });

    it("floats action-required rows above newer activity and shows status chips", async () => {
      // SESSION_2 (action_required) is OLDER than SESSION_1 but must lead.
      setup([SESSION_1, SESSION_2]);

      await waitFor(() => {
        expect(screen.getByText("Disk full on db-02")).toBeInTheDocument();
      });
      const rows = screen.getAllByRole("listitem");
      expect(rows[0]).toHaveTextContent("Disk full on db-02");
      expect(rows[0]).toHaveTextContent("Action required");
      expect(rows[1]).toHaveTextContent("CPU spike on web-01");
      expect(rows[1]).toHaveTextContent("Resolved");
      // Resolved rows lead with the root-cause line.
      expect(rows[1]).toHaveTextContent("OOM after deploy");
    });
  });
});
