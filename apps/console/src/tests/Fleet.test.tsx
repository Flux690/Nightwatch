import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import type { FleetRunner } from "@nightwatch/shared";

import { FleetPage } from "../pages/Fleet.js";
import { theme, cssVariablesResolver } from "../theme.js";

const WEB_RUNNER: FleetRunner = {
  runnerId: "runner-web-01",
  hostname: "web-01",
  online: true,
  lastSeen: 1700000000000,
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
};

const DB_RUNNER: FleetRunner = {
  runnerId: "runner-db-02",
  hostname: "db-02",
  online: false,
  lastSeen: 1600000000000,
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
};

function setup(fleet: FleetRunner[] = []) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url === "/api/fleet") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(fleet) });
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

  return { fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FleetPage", () => {
  it("fetches GET /api/fleet on mount", async () => {
    const { fetchMock } = setup();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/fleet");
    });
  });

  it("renders a runner's hostname, connection status, and advertised services", async () => {
    setup([WEB_RUNNER]);
    await waitFor(() => {
      expect(screen.getByText("web-01")).toBeInTheDocument();
    });
    expect(screen.getByText(/^online$/i)).toBeInTheDocument();
    expect(screen.getByText("docker/nginx/nginx")).toBeInTheDocument();
    expect(screen.getByText("docker/api/api")).toBeInTheDocument();
  });

  it("renders an offline runner and a Kubernetes service identity", async () => {
    setup([DB_RUNNER]);
    await waitFor(() => {
      expect(screen.getByText("db-02")).toBeInTheDocument();
    });
    expect(screen.getByText(/^offline$/i)).toBeInTheDocument();
    expect(
      screen.getByText("kubernetes/production/postgres"),
    ).toBeInTheDocument();
  });

  it("shows an empty state when no runners are connected", async () => {
    setup([]);
    await waitFor(() => {
      expect(screen.getByText(/no runners connected/i)).toBeInTheDocument();
    });
  });
});
