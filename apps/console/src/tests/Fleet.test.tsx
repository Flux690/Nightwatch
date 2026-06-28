import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import type { RunnerRecord } from "@nightwatch/shared";

import { FleetPage } from "../pages/Fleet.js";
import { theme, cssVariablesResolver } from "../theme.js";

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
  id: "runner-web-01",
  token: "token-abc123",
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date(NOW - 30 * 1000).toISOString(),
  manifest: {
    runnerId: "runner-web-01",
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
      prometheus: { available: false },
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
  id: "runner-db-02",
  token: "token-def456",
  hostname: "db-02",
  createdAt: "2024-01-01T00:00:00Z",
  online: false,
  lastSeen: new Date(NOW - 5 * 60 * 1000).toISOString(),
  manifest: {
    runnerId: "runner-db-02",
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
      prometheus: { available: false },
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: false,
      fileRead: true,
      remediationEnabled: false,
    },
  },
  remediationMode: false,
};

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

  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      <QueryClientProvider client={qc}>
        <FleetPage />
      </QueryClientProvider>
    </MantineProvider>,
  );

  return { fetchMock, qc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FleetPage", () => {
  describe("fleet list", () => {
    it("fetches GET /api/runners on mount", async () => {
      const { fetchMock } = setup();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/runners");
      });
    });

    it("hides a runner that has never connected (no hostname)", async () => {
      setup([AWAITING_RUNNER]);
      // A minted-but-never-connected token is a credential, not a fleet member,
      // so it is filtered out and the page settles into the empty state.
      await waitFor(() => {
        expect(screen.getByText(/no runners connected/i)).toBeInTheDocument();
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
      expect(screen.getByText("docker/nginx/nginx")).toBeInTheDocument();
      expect(screen.getByText("docker/api/api")).toBeInTheDocument();
      expect(screen.getByText("30s ago")).toBeInTheDocument();
    });

    it("renders an offline runner and a Kubernetes service identity", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      setup([DB_RUNNER]);
      await waitFor(() => {
        expect(screen.getByText("db-02")).toBeInTheDocument();
      });
      expect(screen.getByText(/^offline$/i)).toBeInTheDocument();
      expect(
        screen.getByText("kubernetes/production/postgres"),
      ).toBeInTheDocument();
      expect(screen.getByText("5m ago")).toBeInTheDocument();
    });

    it("shows an empty state when no runners are connected", async () => {
      setup([]);
      await waitFor(() => {
        expect(screen.getByText(/no runners connected/i)).toBeInTheDocument();
      });
    });

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
      render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="light"
        >
          <QueryClientProvider client={qc}>
            <FleetPage />
          </QueryClientProvider>
        </MantineProvider>,
      );

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

  describe("Add a server", () => {
    it("opens the add-server wizard when 'Add a server' is clicked", async () => {
      const user = userEvent.setup();
      setup([]);
      await user.click(screen.getByRole("button", { name: /add a server/i }));
      await waitFor(() => {
        expect(
          screen.getByRole("radio", { name: /docker/i }),
        ).toBeInTheDocument();
      });
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
      render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="light"
        >
          <QueryClientProvider client={qc}>
            <FleetPage />
          </QueryClientProvider>
        </MantineProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText("web-01")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /remove/i }));

      await waitFor(() => {
        expect(screen.queryByText("web-01")).not.toBeInTheDocument();
      });
    });
  });
});
