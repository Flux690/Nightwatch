import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type {
  GitHubIntegrationStatus,
  RunnerRecord,
} from "@nightwarden/shared";

import { TestProviders } from "./renderWithProviders.js";
import { IntegrationsRail } from "@/components/layout/IntegrationsRail";

const NOT_CONFIGURED: GitHubIntegrationStatus = {
  configured: false,
  repo: null,
  expiresAt: null,
  validatedAt: null,
};

const CONFIGURED: GitHubIntegrationStatus = {
  configured: true,
  repo: "acme/api",
  expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
  validatedAt: new Date().toISOString(),
};

const CONNECTED_RUNNER: RunnerRecord = {
  id: "runner-1",
  token: "runner-1",
  serverName: "prod-web-01",
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date().toISOString(),
  manifest: null,
};

/* The rail navigates to each integration's own route, so it renders under a
   memory router with stub destinations. */
function renderRailRoute(qc: QueryClient) {
  const rootRoute = createRootRoute();
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: IntegrationsRail,
  });
  const connectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/github",
    component: () => <div>GitHub connect destination</div>,
  });
  const runnerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/runner",
    component: () => <div>Runner servers destination</div>,
  });
  const addServerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/runner/add",
    component: () => <div>Add server destination</div>,
  });
  const alertmanagerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/alertmanager",
    component: () => <div>Alertmanager destination</div>,
  });
  const prometheusRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/prometheus",
    component: () => <div>Prometheus destination</div>,
  });
  const lokiRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/loki",
    component: () => <div>Loki destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      integrationsRoute,
      connectRoute,
      runnerRoute,
      addServerRoute,
      alertmanagerRoute,
      prometheusRoute,
      lokiRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ["/integrations"] }),
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
    github?: GitHubIntegrationStatus;
    runners?: RunnerRecord[];
    ingestConfigured?: boolean;
    lastReceivedAt?: string | null;
    prometheusConfigured?: boolean;
    lokiConfigured?: boolean;
  } = {},
) {
  const {
    github = NOT_CONFIGURED,
    runners = [],
    ingestConfigured = false,
    lastReceivedAt = null,
    prometheusConfigured = false,
    lokiConfigured = false,
  } = opts;

  const fetchMock = vi
    .fn<(url: string, init?: RequestInit) => Promise<unknown>>()
    .mockImplementation((url: string) => {
      const body =
        url === "/api/runners"
          ? runners
          : url === "/api/integrations/alertmanager"
            ? { configured: ingestConfigured, lastReceivedAt }
            : url === "/api/integrations/prometheus"
              ? {
                  configured: prometheusConfigured,
                  url: prometheusConfigured ? "http://prom:9090" : null,
                  hasAuth: false,
                  validatedAt: null,
                }
              : url === "/api/integrations/loki"
                ? {
                    configured: lokiConfigured,
                    url: lokiConfigured ? "http://loki:3100" : null,
                    hasAuth: false,
                    hasOrgId: false,
                    validatedAt: null,
                  }
                : github;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      });
    });
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = renderRailRoute(qc);
  return { fetchMock, qc, view };
}

function rowFor(title: string): HTMLElement {
  return screen.getByRole("button", { name: title });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("IntegrationsRail", () => {
  describe("GitHub", () => {
    it("shows Not connected and navigates to the GitHub connect route", async () => {
      const user = userEvent.setup();
      setup();

      await screen.findByText("GitHub");
      expect(
        await within(rowFor("GitHub")).findByText("Not connected"),
      ).toBeInTheDocument();

      await user.click(rowFor("GitHub"));
      expect(
        await screen.findByText(/github connect destination/i),
      ).toBeInTheDocument();
    });

    it("shows Connected under Installed once configured", async () => {
      const user = userEvent.setup();
      setup({ github: CONFIGURED });

      await screen.findByText("GitHub");
      await waitFor(() => {
        expect(
          within(rowFor("GitHub")).getByText("Connected"),
        ).toBeInTheDocument();
      });
      expect(screen.getByText("Installed")).toBeInTheDocument();

      await user.click(rowFor("GitHub"));
      expect(
        await screen.findByText(/github connect destination/i),
      ).toBeInTheDocument();
    });
  });

  describe("NightWarden Runner", () => {
    it("routes an empty fleet straight to the add-server wizard", async () => {
      const user = userEvent.setup();
      setup({ runners: [] });

      await screen.findByText("NightWarden Runner");
      await user.click(rowFor("NightWarden Runner"));

      expect(
        await screen.findByText(/add server destination/i),
      ).toBeInTheDocument();
    });

    it("shows the connected server count and opens the server list", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });

      expect(await screen.findByText("1 server")).toBeInTheDocument();

      await user.click(rowFor("NightWarden Runner"));
      expect(
        await screen.findByText(/runner servers destination/i),
      ).toBeInTheDocument();
    });
  });

  describe("Alertmanager", () => {
    it("offers setup when no credential exists and opens the Alertmanager page", async () => {
      const user = userEvent.setup();
      setup({ ingestConfigured: false });

      await screen.findByText("Alertmanager");
      expect(
        await within(rowFor("Alertmanager")).findByText("Not connected"),
      ).toBeInTheDocument();

      await user.click(rowFor("Alertmanager"));
      expect(
        await screen.findByText(/alertmanager destination/i),
      ).toBeInTheDocument();
    });

    it("reports delivery state, not credential existence: waiting is muted, receiving is green", async () => {
      const { view } = setup({ ingestConfigured: true });
      const waiting = await screen.findByText("Waiting for first alert");
      expect(waiting).toHaveClass("text-muted-foreground");
      view.unmount();
      vi.unstubAllGlobals();

      setup({
        ingestConfigured: true,
        lastReceivedAt: new Date().toISOString(),
      });
      const receiving = await screen.findByText("Receiving");
      expect(receiving).toHaveClass("text-success");
    });
  });

  describe("Prometheus and Loki", () => {
    it("navigates to each page and reports connected once configured", async () => {
      const user = userEvent.setup();
      const { view } = setup({ prometheusConfigured: true });

      await screen.findByText("Prometheus");
      await waitFor(() => {
        expect(
          within(rowFor("Prometheus")).getByText("Connected"),
        ).toBeInTheDocument();
      });
      await user.click(rowFor("Prometheus"));
      expect(
        await screen.findByText(/prometheus destination/i),
      ).toBeInTheDocument();
      view.unmount();
      vi.unstubAllGlobals();

      setup({ lokiConfigured: true });
      await screen.findByText("Loki");
      await waitFor(() => {
        expect(
          within(rowFor("Loki")).getByText("Connected"),
        ).toBeInTheDocument();
      });
    });
  });
});
