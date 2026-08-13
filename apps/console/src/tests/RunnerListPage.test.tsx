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
import type { RunnerRecord } from "@nightwarden/shared";

import { RunnerListPage } from "../pages/RunnerListPage.js";

const NOW = new Date("2024-01-01T12:00:00Z").getTime();

const WEB_RUNNER: RunnerRecord = {
  id: "token-abc123",
  token: "token-abc123",
  platform: "docker" as const,
  serverName: null,
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date(NOW - 30 * 1000).toISOString(),
  manifest: {
    platform: "docker" as const,
    hostname: "web-01",
    runnerVersion: "0.1.0",
    services: [
      {
        identity: { project: "nginx", service: "nginx" },
        target: "docker/nginx/nginx",
        status: "running",
      },
      {
        identity: { project: "api", service: "api" },
        target: "docker/api/api",
        status: "running",
      },
    ],
  },
};

/* The page navigates to the add-server route and back to Integrations, so it renders
   under a memory router with stub destination routes. */
function renderRunnerServersRoute(qc: QueryClient) {
  const rootRoute = createRootRoute();
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const runnerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/docker",
    component: () => <RunnerListPage platform="docker" />,
  });
  const addServerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/docker/add",
    component: () => <div>Add server destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      integrationsRoute,
      runnerRoute,
      addServerRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/integrations/docker"] }),
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

  renderRunnerServersRoute(qc);

  return { fetchMock, qc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RunnerListPage", () => {
  describe("server list", () => {
    it("shows every advertised identity key in full", async () => {
      setup([WEB_RUNNER]);

      // A row clipped this to its first key; the user needs the whole list,
      // since these are exactly what an alert's labels have to match.
      expect(await screen.findByText("docker/nginx/nginx")).toBeInTheDocument();
      expect(screen.getByText("docker/api/api")).toBeInTheDocument();
    });

    it("fetches GET /api/runners on mount", async () => {
      const { fetchMock } = setup();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/runners");
      });
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

      renderRunnerServersRoute(qc);

      await waitFor(() => {
        expect(
          screen.getByText(/failed to load docker hosts/i),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Add a server", () => {
    it("navigates to the add wizard from the header action", async () => {
      const user = userEvent.setup();
      setup([]);
      await user.click(
        await screen.findByRole("button", { name: /add a docker host/i }),
      );
      expect(
        await screen.findByText(/add server destination/i),
      ).toBeInTheDocument();
    });
  });

  describe("Remove", () => {
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
      renderRunnerServersRoute(qc);

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
