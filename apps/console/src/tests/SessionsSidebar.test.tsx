import { render, screen, waitFor } from "@testing-library/react";
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

import { SessionsSidebar } from "../pages/SessionsSidebar.js";
import { theme, cssVariablesResolver } from "../theme.js";

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
  title: "CPU spike on web-01",
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(), // 2 min ago
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

function setup(sessions: object[] = [SESSION_1], deleteOk = true) {
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
  const router = createRouter({
    routeTree: root.addChildren([sessionsRoute, sessionIdRoute]),
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

      // Wait for runners to load (sidebar is visible)
      await waitFor(() => {
        expect(screen.queryAllByRole("listitem")).toHaveLength(0);
      });
    });

    it("fetches sessions and renders a row for each", async () => {
      setup();

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });
    });

    it("shows an empty-state message when there are no sessions", async () => {
      setup([]);

      await waitFor(() => {
        expect(screen.getByText(/no sessions yet/i)).toBeInTheDocument();
      });
    });

    it("shows a relative timestamp on each row", async () => {
      setup();

      await waitFor(() => {
        expect(screen.getByText(/ago/i)).toBeInTheDocument();
      });
    });

    it("renders no status badge on session rows", async () => {
      setup();

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });

      expect(screen.queryByText("concluded")).not.toBeInTheDocument();
      expect(screen.queryByText("streaming")).not.toBeInTheDocument();
      expect(screen.queryByText("awaiting-approval")).not.toBeInTheDocument();
    });
  });

  describe("delete", () => {
    it("renders a delete button per session row", async () => {
      setup();

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });
      expect(
        screen.getByRole("button", { name: /delete session/i }),
      ).toBeInTheDocument();
    });

    it("deletes the session when confirmed and removes it from the list", async () => {
      const user = userEvent.setup();
      vi.spyOn(window, "confirm").mockReturnValue(true);
      setup();
      const fetchMock = vi.mocked(fetch);

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /delete session/i }));

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
      vi.spyOn(window, "confirm").mockReturnValue(true);
      setup([SESSION_1], false);

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /delete session/i }));

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

    it("does not delete when the confirmation is dismissed", async () => {
      const user = userEvent.setup();
      vi.spyOn(window, "confirm").mockReturnValue(false);
      setup();

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /delete session/i }));

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
});
