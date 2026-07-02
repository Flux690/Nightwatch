import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { TestProviders } from "./renderWithProviders.js";
import type { RunnerRecord } from "@nightwatch/shared";

import { FleetPage } from "../pages/Fleet.js";

const NOW = new Date("2024-01-01T12:00:00Z").getTime();

const AWAITING_RUNNER: RunnerRecord = {
  id: "token-uuid-1",
  token: "token-uuid-1",
  hostname: null,
  createdAt: "2024-01-01T00:00:00Z",
  online: false,
  lastSeen: null,
  manifest: null,
  remediationMode: null,
};

const WEB_RUNNER: RunnerRecord = {
  id: "token-abc123",
  token: "token-abc123",
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date(NOW - 30 * 1000).toISOString(),
  manifest: {
    hostname: "web-01",
    runnerVersion: "0.1.0",
    capabilities: {
      docker: true,
      kubernetes: false,
      services: [
        {
          identity: { provider: "docker", project: "nginx", service: "nginx" },
          status: "running",
        },
        {
          identity: { provider: "docker", project: "api", service: "api" },
          status: "running",
        },
      ],
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: false,
      fileRead: true,
      remediationEnabled: false,
    },
  },
  remediationMode: false,
};

const DB_RUNNER: RunnerRecord = {
  id: "token-def456",
  token: "token-def456",
  hostname: "db-02",
  createdAt: "2024-01-01T00:00:00Z",
  online: false,
  lastSeen: new Date(NOW - 5 * 60 * 1000).toISOString(),
  manifest: {
    hostname: "db-02",
    runnerVersion: "0.1.0",
    capabilities: {
      docker: false,
      kubernetes: true,
      services: [
        {
          identity: {
            provider: "kubernetes",
            namespace: "production",
            workload: "postgres",
          },
          status: "running",
        },
      ],
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: false,
      fileRead: true,
      remediationEnabled: false,
    },
  },
  remediationMode: false,
};

/* FleetPage navigates to /fleet/add, so it renders under a memory router
   with a stub destination route. */
function renderFleetRoute(qc: QueryClient) {
  const rootRoute = createRootRoute();
  const fleetRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/fleet",
    component: FleetPage,
  });
  const addServerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/fleet/add",
    component: () => <div>Add server destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([fleetRoute, addServerRoute]),
    history: createMemoryHistory({ initialEntries: ["/fleet"] }),
  });
  return render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );
}

function setup(runners: RunnerRecord[] = []) {
  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/runners") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runners),
        });
      }
      if (url.startsWith("/api/tokens/") && init?.method === "DELETE") {
        return Promise.resolve({
          ok: true,
          status: 204,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  renderFleetRoute(qc);

  return { fetchMock, qc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FleetPage", () => {
  describe("table semantics", () => {
    it("renders a semantic table with column headers", async () => {
      setup([WEB_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });
      expect(screen.getByRole("table")).toBeInTheDocument();
      expect(
        screen.getByRole("columnheader", { name: /server/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("columnheader", { name: /status/i }),
      ).toBeInTheDocument();
    });

    it("uses tnum on numeric cells (services count, last seen)", async () => {
      setup([WEB_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });
      const cells = document.querySelectorAll("td[data-mono]");
      expect(cells.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("fleet list", () => {
    it("fetches GET /api/runners on mount", async () => {
      const { fetchMock } = setup();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/runners");
      });
    });

    it("hides a runner that has never connected (no hostname)", async () => {
      setup([AWAITING_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText(/your fleet is empty/i)).toBeInTheDocument();
      });
      expect(
        screen.queryByText(/awaiting connection/i),
      ).not.toBeInTheDocument();
    });

    it("renders an online runner's hostname, status badge, services, and last-seen", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      setup([WEB_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });
      expect(screen.getByText(/^online$/i)).toBeInTheDocument();
      expect(screen.getByText(/docker\/nginx\/nginx/)).toBeInTheDocument();
      expect(screen.getByText("30s ago")).toBeInTheDocument();
    });

    it("renders an offline runner with reduced opacity", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      setup([DB_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("db-02")).toBeInTheDocument();
      });
      expect(screen.getByText(/^offline$/i)).toBeInTheDocument();
      const row = screen.getByText("db-02").closest("tr");
      expect(row?.dataset.offline).toBeDefined();
    });

    it("renders a Kubernetes service identity", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      setup([DB_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("db-02")).toBeInTheDocument();
      });
      expect(
        screen.getByText(/kubernetes\/production\/postgres/),
      ).toBeInTheDocument();
      expect(screen.getByText("5m ago")).toBeInTheDocument();
    });
  });

  describe("empty state", () => {
    it("shows the Linear two-region empty state when no runners are connected", async () => {
      setup([]);
      await waitFor(() => {
        expect(screen.getByText(/your fleet is empty/i)).toBeInTheDocument();
      });
      expect(
        screen.getByRole("button", { name: /add your first server/i }),
      ).toBeInTheDocument();
    });

    it("shows exactly one add-server call to action in the empty state", async () => {
      setup([]);
      await waitFor(() => {
        expect(screen.getByText(/your fleet is empty/i)).toBeInTheDocument();
      });
      expect(
        screen.getByRole("heading", { name: /fleet/i }),
      ).toBeInTheDocument();
      const addButtons = screen.getAllByRole("button", {
        name: /add .*server/i,
      });
      expect(addButtons).toHaveLength(1);
      expect(addButtons[0]).toHaveTextContent(/add your first server/i);
    });

    it("shows the header add-server action once the fleet has rows", async () => {
      setup([WEB_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });
      const addButton = screen.getByRole("button", { name: /add a server/i });
      expect(addButton.closest("header")).not.toBeNull();
    });
  });

  describe("loading state", () => {
    it("shows skeleton rows while loading", async () => {
      setup();
      expect(
        await screen.findByRole("status", { name: /loading fleet/i }),
      ).toBeInTheDocument();
      expect(document.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    });
  });

  describe("error state", () => {
    it("shows an error alert when the fetch fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 500 }),
      );

      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });

      renderFleetRoute(qc);

      await waitFor(() => {
        expect(screen.getByText(/failed to load fleet/i)).toBeInTheDocument();
      });
    });
  });

  describe("sorting", () => {
    it("sorts by server name ascending by default", async () => {
      setup([DB_RUNNER, WEB_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });
      const rows = screen.getAllByRole("row");
      const dataRows = rows.slice(1);
      expect(dataRows[0].textContent).toContain("db-02");
      expect(dataRows[1].textContent).toContain("web-01");
    });

    it("toggles sort direction on column header click", async () => {
      const user = userEvent.setup();
      setup([DB_RUNNER, WEB_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /^server/i }));

      const rows = screen.getAllByRole("row");
      const dataRows = rows.slice(1);
      expect(dataRows[0].textContent).toContain("web-01");
      expect(dataRows[1].textContent).toContain("db-02");
    });

    it("sortable headers are keyboard-operable", async () => {
      const user = userEvent.setup();
      setup([DB_RUNNER, WEB_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });

      const serverSortBtn = screen.getByRole("button", { name: /^server/i });
      serverSortBtn.focus();
      await user.keyboard("{Enter}");

      const rows = screen.getAllByRole("row");
      const dataRows = rows.slice(1);
      expect(dataRows[0].textContent).toContain("web-01");
    });
  });

  describe("Add a server", () => {
    it("navigates to the add-server page when the empty-state action is clicked", async () => {
      const user = userEvent.setup();
      setup([]);
      await user.click(
        await screen.findByRole("button", { name: /add your first server/i }),
      );
      expect(
        await screen.findByText(/add server destination/i),
      ).toBeInTheDocument();
    });
  });

  describe("Remove", () => {
    it("shows a Remove button for each connected runner", async () => {
      setup([WEB_RUNNER]);
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /remove/i }),
        ).toBeInTheDocument();
      });
    });

    it("calls DELETE /api/tokens/:token when Remove is clicked", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup([WEB_RUNNER]);

      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /remove/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/tokens/${WEB_RUNNER.token}`,
          expect.objectContaining({ method: "DELETE" }),
        );
      });
    });

    it("runner row disappears after Remove via runners refetch", async () => {
      const user = userEvent.setup();
      let runnersCallCount = 0;

      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          if (url === "/api/runners") {
            runnersCallCount += 1;
            const result = runnersCallCount === 1 ? [WEB_RUNNER] : [];
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(result),
            });
          }
          if (url.startsWith("/api/tokens/") && init?.method === "DELETE") {
            return Promise.resolve({
              ok: true,
              status: 204,
              json: () => Promise.resolve({}),
            });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }),
      );

      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      renderFleetRoute(qc);

      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /remove/i }));

      await waitFor(() => {
        expect(screen.queryByText("web-01")).not.toBeInTheDocument();
      });
    });

    it("row action click does not trigger row navigation", async () => {
      const user = userEvent.setup();
      setup([WEB_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });
      const removeBtn = screen.getByRole("button", { name: /remove/i });
      const clickEvent = new MouseEvent("click", { bubbles: true });
      const stopSpy = vi.spyOn(clickEvent, "stopPropagation");
      removeBtn.dispatchEvent(clickEvent);
      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe("polling", () => {
    it("re-polls every 30s, picking up a runner that has gone offline", async () => {
      vi.useFakeTimers();
      let call = 0;
      const fetchMock = vi.fn().mockImplementation(() => {
        call += 1;
        const online = call === 1;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ ...WEB_RUNNER, online }]),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const qc = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      renderFleetRoute(qc);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/^online$/i)).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const polled = qc.getQueryData<RunnerRecord[]>(["runners"]);
      expect(polled?.[0].online).toBe(false);
    });
  });
});
