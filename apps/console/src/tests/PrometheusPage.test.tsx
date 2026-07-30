import { render, screen, waitFor } from "@testing-library/react";
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
import type {
  PrometheusIntegrationStatus,
  RunnerRecord,
} from "@nightwarden/shared";

import { PrometheusPage } from "../pages/PrometheusPage.js";

const NOT_CONFIGURED: PrometheusIntegrationStatus = {
  configured: false,
  url: null,
  hasAuth: false,
  validatedAt: null,
};

const CONFIGURED: PrometheusIntegrationStatus = {
  configured: true,
  url: "http://prom.internal:9090",
  hasAuth: true,
  validatedAt: "2026-07-17T00:00:00.000Z",
};

const CONNECTED_RUNNER: RunnerRecord = {
  id: "runner-1",
  token: "runner-1",
  platform: "docker" as const,
  serverName: "prod-web-01",
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date().toISOString(),
  manifest: null,
};

function jsonOk(body: unknown, status = 200) {
  return Promise.resolve({
    ok: true,
    status,
    json: () => Promise.resolve(body),
  });
}

function renderPrometheusRoute() {
  const rootRoute = createRootRoute();
  const prometheusRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/prometheus",
    component: PrometheusPage,
  });
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([prometheusRoute, integrationsRoute]),
    history: createMemoryHistory({
      initialEntries: ["/integrations/prometheus"],
    }),
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );
}

function setup(
  opts: {
    status?: PrometheusIntegrationStatus;
    runners?: RunnerRecord[];
    connectStatus?: number;
    connectBody?: unknown;
  } = {},
) {
  const {
    status = NOT_CONFIGURED,
    runners = [],
    connectStatus = 201,
    connectBody = CONFIGURED,
  } = opts;
  let connected = status.configured;

  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/runners") return jsonOk(runners);
      if (url === "/api/integrations/prometheus" && init?.method === "POST") {
        if (connectStatus >= 400) {
          return Promise.resolve({
            ok: false,
            status: connectStatus,
            json: () => Promise.resolve(connectBody),
          });
        }
        connected = true;
        return jsonOk(connectBody, connectStatus);
      }
      if (url === "/api/integrations/prometheus" && init?.method === "DELETE")
        return Promise.resolve({
          ok: true,
          status: 204,
          json: () => Promise.resolve(undefined),
        });
      if (url === "/api/integrations/prometheus")
        return jsonOk(connected ? CONFIGURED : NOT_CONFIGURED);
      return jsonOk({});
    });
  vi.stubGlobal("fetch", fetchMock);

  renderPrometheusRoute();
  return { fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PrometheusPage", () => {
  it("connects with URL and optional auth header, sending only what was filled", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup();

    await user.type(
      await screen.findByLabelText(/prometheus url/i),
      "http://prom.internal:9090",
    );
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations/prometheus",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ url: "http://prom.internal:9090" }),
        }),
      );
    });
    // The empty optional header is omitted, not sent as "".
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("shows the API's error when the probe fails and stays unconfigured", async () => {
    const user = userEvent.setup();
    setup({
      connectStatus: 502,
      connectBody: { error: "Could not reach Prometheus", code: "network" },
    });

    await user.type(
      await screen.findByLabelText(/prometheus url/i),
      "http://wrong:9090",
    );
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    expect(await screen.findByText(/could not connect/i)).toBeInTheDocument();
    expect(screen.getByText(/could not reach prometheus/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/prometheus url/i)).toBeInTheDocument();
  });

  it("connected view offers test, disconnect, and hides the label check with no runners", async () => {
    setup({ status: CONFIGURED });

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("http://prom.internal:9090")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
  });
});
