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

// One flat list: an alert-opened session, a session someone typed, a crashed
// run and a live one all render side by side, in the order the API returned.
const SESSION_1 = {
  sessionId: "s1",
  title: "CPU spike on web-01",
  createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  investigation: true,
  severity: "warning",
  status: "resolved",
  awaitingHumanInput: false,
};

const SESSION_2 = {
  sessionId: "s2",
  title: "Disk full on db-02",
  createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  investigation: true,
  severity: "critical",
  status: "action_required",
  awaitingHumanInput: true,
};

const CHAT_1 = {
  sessionId: "c1",
  title: "What does OOM mean?",
  createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 60 * 1000).toISOString(),
  investigation: false,
  severity: null,
  status: null,
  awaitingHumanInput: false,
};

const FAILED_1 = {
  sessionId: "s3",
  title: "Crashed run on api-03",
  createdAt: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
  investigation: true,
  severity: "info",
  status: "failed",
  awaitingHumanInput: false,
};

const STOPPED_1 = {
  sessionId: "s4",
  title: "Abandoned run on cache-01",
  createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
  investigation: true,
  severity: null,
  status: "stopped",
  awaitingHumanInput: false,
};

const RUNNING_1 = {
  sessionId: "s5",
  title: "Latency spike on edge-01",
  createdAt: new Date(Date.now() - 30 * 1000).toISOString(),
  lastActivityAt: new Date(Date.now() - 30 * 1000).toISOString(),
  investigation: true,
  severity: null,
  status: "investigating",
  awaitingHumanInput: false,
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

// The API serves one page at a time and owns the order; `pages` is what each
// successive request answers, so a test can drive "Load older sessions".
function setup(
  pages: object[][] = [[SESSION_1]],
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
        const offset = Number(
          new URL(url, "http://test").searchParams.get("offset") ?? 0,
        );
        // Offsets are page indexes here: every page carries one row.
        const rows = pages[offset] ?? [];
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              rows,
              nextOffset: offset + 1 < pages.length ? offset + 1 : null,
            }),
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
      setup([[SESSION_1]], false);

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

  describe("one flat list", () => {
    it("shows every session together, whatever kind of work it is", async () => {
      setup([[SESSION_1, CHAT_1, FAILED_1]]);

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });
      // No tab was touched: a failed run and a typed question are simply there.
      expect(screen.getByText("What does OOM mean?")).toBeInTheDocument();
      expect(screen.getByText("Crashed run on api-03")).toBeInTheDocument();
      expect(screen.queryByRole("tab")).not.toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(3);
    });

    it("says so when there is nothing to list", async () => {
      setup([[]]);

      expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
    });

    it("keeps the API's order, which leads with a session blocked on a human", async () => {
      // The API floats SESSION_2 despite it being the oldest; the sidebar must
      // render that order rather than sorting a page of its own.
      setup([[SESSION_2, CHAT_1, SESSION_1]]);

      await waitFor(() => {
        expect(screen.getByText("Disk full on db-02")).toBeInTheDocument();
      });
      const rows = screen.getAllByRole("listitem");
      expect(rows[0]).toHaveTextContent("Disk full on db-02");
      expect(rows[1]).toHaveTextContent("What does OOM mean?");
      expect(rows[2]).toHaveTextContent("CPU spike on web-01");
    });
  });

  describe("the row", () => {
    it("states the status as a word and carries no second line", async () => {
      setup([[SESSION_1, SESSION_2, FAILED_1]]);

      await waitFor(() => {
        expect(screen.getByText("Resolved")).toBeInTheDocument();
      });
      expect(screen.getByText("Action required")).toBeInTheDocument();
      expect(screen.getByText("Failed")).toBeInTheDocument();
      // The root-cause line the second line used to carry is gone entirely.
      expect(screen.queryByText(/started by you/i)).not.toBeInTheDocument();
    });

    it("says nothing for a session no word applies to", async () => {
      setup([[CHAT_1, STOPPED_1]]);

      await waitFor(() => {
        expect(
          screen.getByText("Abandoned run on cache-01"),
        ).toBeInTheDocument();
      });
      // "Stopped" is not one of the five words, and a plain session has none.
      const rows = screen.getAllByRole("listitem");
      for (const row of rows) {
        expect(row).not.toHaveTextContent(
          /action required|investigating|resolved|inconclusive|failed|stopped/i,
        );
      }
    });

    it("stays silent about a run the reader is already watching", async () => {
      setup([[RUNNING_1]], true, "/sessions/s5");

      await waitFor(() => {
        expect(
          screen.getByText("Latency spike on edge-01"),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText("Investigating")).not.toBeInTheDocument();
    });

    it("reports the running session the reader is not watching", async () => {
      setup([[RUNNING_1]], true, "/sessions/s1");

      expect(await screen.findByText("Investigating")).toBeInTheDocument();
    });

    it("states Critical in words, and nothing for warning or info", async () => {
      setup([[SESSION_1, SESSION_2, FAILED_1]]);

      await waitFor(() => {
        expect(screen.getByText("Critical")).toBeInTheDocument();
      });
      expect(screen.queryByText(/warning/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^info$/i)).not.toBeInTheDocument();
    });
  });
  describe("pagination", () => {
    it("reaches sessions beyond the first page and keeps the ones already shown", async () => {
      const user = userEvent.setup();
      setup([[SESSION_2], [SESSION_1]]);

      await waitFor(() => {
        expect(screen.getByText("Disk full on db-02")).toBeInTheDocument();
      });
      expect(screen.queryByText("CPU spike on web-01")).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: /load older sessions/i }),
      );

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });
      const rows = screen.getAllByRole("listitem");
      expect(rows[0]).toHaveTextContent("Disk full on db-02");
      expect(rows[1]).toHaveTextContent("CPU spike on web-01");
    });

    it("renders a session once when it shifts across a page boundary", async () => {
      const user = userEvent.setup();
      // Pages are fetched at fixed offsets, so a session that moves between the
      // two fetches is served on both. It is still one session.
      setup([[SESSION_2], [SESSION_2, SESSION_1]]);

      await waitFor(() => {
        expect(screen.getByText("Disk full on db-02")).toBeInTheDocument();
      });
      await user.click(
        screen.getByRole("button", { name: /load older sessions/i }),
      );

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });
      expect(screen.getAllByText("Disk full on db-02")).toHaveLength(1);
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });

    it("offers nothing to load when the first page is the whole list", async () => {
      setup();

      await waitFor(() => {
        expect(screen.getByText("CPU spike on web-01")).toBeInTheDocument();
      });
      expect(
        screen.queryByRole("button", { name: /load older sessions/i }),
      ).not.toBeInTheDocument();
    });
  });
});
