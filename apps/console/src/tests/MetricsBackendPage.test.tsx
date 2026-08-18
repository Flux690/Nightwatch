import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  MetricsBackendKind,
  MetricsBackendStatus,
} from "@nightwarden/shared";

import { TestProviders } from "./renderWithProviders.js";
import { MetricsBackendPage } from "../pages/MetricsBackendPage.js";

// The page navigates on disconnect, so it needs a real router around it.
function renderPage(kind: MetricsBackendKind) {
  const rootRoute = createRootRoute();
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/metrics/$kind",
    component: () => <MetricsBackendPage kind={kind} />,
  });
  const integrations = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page, integrations]),
    history: createMemoryHistory({
      initialEntries: [`/integrations/metrics/${kind}`],
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

function connected(over: Partial<MetricsBackendStatus> = {}) {
  return {
    id: "b1",
    kind: "victoriametrics",
    label: "vm-prod",
    query: { url: "http://vmselect:8481", hasAuth: false, hasOrgId: false },
    rules: { url: "http://vmalert:8880", hasAuth: false, hasOrgId: false },
    validatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

// Captures what the page posts, and answers the list from whatever a case sets.
function stubApi(list: unknown[]) {
  const posted: Array<Record<string, unknown>> = [];
  const fetchMock = vi
    .fn<(url: string, init?: RequestInit) => Promise<unknown>>()
    .mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(init?.method === "POST" ? list[0] : list),
      });
    });
  vi.stubGlobal("fetch", fetchMock);
  return posted;
}

describe("MetricsBackendPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // The name is the server's to derive, so the form never asks for one.
  it("posts both endpoints and asks the user for no name", async () => {
    const user = userEvent.setup();
    const posted = stubApi([]);
    renderPage("victoriametrics");

    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    await user.type(
      await screen.findByLabelText("Query URL"),
      "http://vmselect:8481/select/0/prometheus",
    );
    await user.type(
      screen.getByLabelText("Rules URL (optional)"),
      "http://vmalert:8880",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      kind: "victoriametrics",
      query: { url: "http://vmselect:8481/select/0/prometheus" },
      rules: { url: "http://vmalert:8880" },
    });
  });

  /* A supported configuration that costs something specific, so the page says
     what it costs rather than reporting a plain "Connected". */
  it("says a backend with no rules endpoint can never reach Resolved", async () => {
    stubApi([connected({ rules: null })]);
    renderPage("victoriametrics");

    const warning = await screen.findByText(/No rules endpoint/);
    expect(warning.textContent).toMatch(/will not\s+reach Resolved/);
  });

  it("warns that VictoriaMetrics answers nothing for metric metadata", async () => {
    stubApi([]);
    renderPage("victoriametrics");

    expect(
      await screen.findByText(/does not implement the metric metadata API/),
    ).toBeInTheDocument();
  });

  // Grafana Cloud hands out an instance id and a token, so the pair has to be
  // askable as two fields rather than as a header the user encodes themselves.
  it("offers a username and password pair, which is what Grafana Cloud gives you", async () => {
    stubApi([]);
    renderPage("mimir");

    expect(
      await screen.findByLabelText("Username (optional)"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Password (optional)")).toBeInTheDocument();
  });
});
