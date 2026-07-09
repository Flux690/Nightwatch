import { render, screen } from "@testing-library/react";
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
import type { GitHubIntegrationStatus } from "@nightwatch/shared";

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

/* IntegrationsPage navigates to /integrations/github, so it renders under a
   memory router with a stub destination route - same pattern as
   Fleet.test.tsx for /fleet/add. */
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
  const router = createRouter({
    routeTree: rootRoute.addChildren([integrationsRoute, connectRoute]),
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

function setup(status: GitHubIntegrationStatus = NOT_CONFIGURED) {
  const fetchMock = vi
    .fn<(url: string, init?: RequestInit) => Promise<unknown>>()
    .mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(status),
      }),
    );
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  renderIntegrationsRoute(qc);
  return { fetchMock, qc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("IntegrationsPage", () => {
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

  it("shows plain connected text and a Manage button once configured", async () => {
    const user = userEvent.setup();
    setup(CONFIGURED);

    const connected = await screen.findByText("Connected");
    expect(connected).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage" }));

    expect(
      await screen.findByText(/github connect destination/i),
    ).toBeInTheDocument();
  });
});
