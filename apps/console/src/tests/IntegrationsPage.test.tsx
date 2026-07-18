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
import type { GitHubIntegrationStatus, RunnerRecord } from "@nightwatch/shared";

import { TestProviders } from "./renderWithProviders.js";
import { IntegrationsPage } from "@/pages/IntegrationsPage";

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
  remediationMode: false,
};

/* The page navigates to each integration's own route, so it renders under a
   memory router with stub destinations. */
function renderIntegrationsRoute(qc: QueryClient) {
  const rootRoute = createRootRoute();
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: IntegrationsPage,
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      integrationsRoute,
      connectRoute,
      runnerRoute,
      addServerRoute,
      alertmanagerRoute,
      prometheusRoute,
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
  } = {},
) {
  const {
    github = NOT_CONFIGURED,
    runners = [],
    ingestConfigured = false,
    lastReceivedAt = null,
    prometheusConfigured = false,
  } = opts;

  const fetchMock = vi
    .fn<(url: string, init?: RequestInit) => Promise<unknown>>()
    .mockImplementation((url: string) => {
      const body =
        url === "/api/runners"
          ? runners
          : url === "/api/ingest-credential"
            ? { configured: ingestConfigured, lastReceivedAt }
            : url === "/api/integrations/prometheus"
              ? {
                  configured: prometheusConfigured,
                  url: prometheusConfigured ? "http://prom:9090" : null,
                  hasAuth: false,
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
  const view = renderIntegrationsRoute(qc);
  return { fetchMock, qc, view };
}

function cardFor(title: string): HTMLElement {
  return screen.getByText(title).closest("[data-slot=card]") as HTMLElement;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("IntegrationsPage", () => {
  describe("GitHub", () => {
    it("shows a Connect button and navigates to the GitHub connect route", async () => {
      const user = userEvent.setup();
      setup();

      await user.click(
        await screen.findByRole("button", { name: /connect github/i }),
      );

      expect(
        await screen.findByText(/github connect destination/i),
      ).toBeInTheDocument();
    });

    it("shows plain connected text and opens the page from the card once configured", async () => {
      const user = userEvent.setup();
      setup({ github: CONFIGURED });

      expect(await screen.findByText("Connected")).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "GitHub" }));

      expect(
        await screen.findByText(/github connect destination/i),
      ).toBeInTheDocument();
    });
  });

  describe("Nightwatch Runner", () => {
    it("routes an empty fleet straight to the add-server wizard", async () => {
      const user = userEvent.setup();
      setup({ runners: [] });

      await user.click(
        await screen.findByRole("button", { name: /add a server/i }),
      );

      expect(
        await screen.findByText(/add server destination/i),
      ).toBeInTheDocument();
    });

    it("shows the connected server count and opens the server list", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });

      expect(await screen.findByText("1 server")).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Nightwatch Runner" }),
      );

      expect(
        await screen.findByText(/runner servers destination/i),
      ).toBeInTheDocument();
    });
  });

  describe("Alertmanager", () => {
    it("offers setup when no credential exists and opens the Alertmanager page", async () => {
      const user = userEvent.setup();
      setup({ ingestConfigured: false });

      await user.click(await screen.findByRole("button", { name: /set up/i }));

      expect(
        await screen.findByText(/alertmanager destination/i),
      ).toBeInTheDocument();
    });

    it("reports delivery state, not credential existence: waiting is muted, receiving is green", async () => {
      const { view } = setup({ ingestConfigured: true });
      const waiting = await screen.findByText("Waiting for first alert");
      expect(waiting).toHaveClass("text-muted-foreground");
      expect(screen.queryByText("Configured")).not.toBeInTheDocument();
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

  describe("Prometheus", () => {
    it("offers connect and navigates to the Prometheus page", async () => {
      const user = userEvent.setup();
      setup();

      await user.click(
        await screen.findByRole("button", { name: /connect prometheus/i }),
      );

      expect(
        await screen.findByText(/prometheus destination/i),
      ).toBeInTheDocument();
    });

    it("reports connected once configured", async () => {
      setup({ prometheusConfigured: true });
      await screen.findByText("Prometheus");
      await waitFor(() => {
        expect(
          within(cardFor("Prometheus")).getByText("Connected"),
        ).toBeInTheDocument();
      });
    });
  });
});
