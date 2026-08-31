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
  MetricsSourceKind,
  MetricsSourceStatus,
} from "@nightwarden/shared";

import { TestProviders } from "./renderWithProviders.js";
import { MetricsSourcePage } from "../features/integrations/metrics/MetricsSourcePage.js";

// The page navigates on disconnect, so it needs a real router around it.
function renderPage(kind: MetricsSourceKind) {
  const rootRoute = createRootRoute();
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/metrics/$kind",
    component: () => <MetricsSourcePage kind={kind} />,
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

const NOT_CONNECTED = {
  configured: false,
  kind: null,
  label: null,
  query: null,
  rules: null,
  validatedAt: null,
};

function connected(over: Partial<MetricsSourceStatus> = {}) {
  return {
    configured: true,
    kind: "victoriametrics",
    label: "VictoriaMetrics",
    query: { url: "http://vmselect:8481", hasAuth: false, hasOrgId: false },
    rules: { url: "http://vmalert:8880", hasAuth: false, hasOrgId: false },
    validatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

// Captures what the page posts, and answers the status from what a case sets.
function stubApi(status: unknown) {
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
        json: () => Promise.resolve(status),
      });
    });
  vi.stubGlobal("fetch", fetchMock);
  return posted;
}

describe("MetricsSourcePage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /* One product is connected once, so it is addressed by the product's own
     name and the form has nothing to ask about naming. */
  it("posts both endpoints, and asks for no name", async () => {
    const user = userEvent.setup();
    const posted = stubApi(NOT_CONNECTED);
    renderPage("victoriametrics");

    await user.type(
      await screen.findByLabelText("Query URL"),
      "http://vmselect:8481/select/0/prometheus",
    );
    await user.type(screen.getByLabelText("Rules URL"), "http://vmalert:8880");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      kind: "victoriametrics",
      query: { url: "http://vmselect:8481/select/0/prometheus" },
      rules: { url: "http://vmalert:8880" },
    });
  });

  /* A supported configuration that costs something specific, so the page names
     the path that still works rather than reporting a plain "Connected". */
  it("says what a source with no rules endpoint costs", async () => {
    stubApi(connected({ rules: null }));
    renderPage("victoriametrics");

    const warning = await screen.findByText(/No rules endpoint/);
    expect(warning.textContent).toMatch(/resolved notification/);
    // The header names the product, so the address is what identifies the row.
    expect(screen.getByText("http://vmselect:8481")).toBeInTheDocument();
  });

  it("warns that VictoriaMetrics answers nothing for metric metadata", async () => {
    stubApi(NOT_CONNECTED);
    renderPage("victoriametrics");

    expect(
      await screen.findByText(/does not implement the metric metadata API/),
    ).toBeInTheDocument();
  });

  // Grafana Cloud hands out an instance id and a token, so Mimir opens on the
  // pair rather than on a header the user would encode themselves.
  it("opens Mimir on the pair Grafana Cloud gives you", async () => {
    stubApi(NOT_CONNECTED);
    renderPage("mimir");

    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  /* X-Scope-OrgID is Mimir's alone. VictoriaMetrics carries its tenant in the
     URL path, and Prometheus and Thanos have no such concept at all. */
  it("asks for a tenant on Mimir and nowhere else", async () => {
    stubApi(NOT_CONNECTED);
    renderPage("mimir");
    expect(await screen.findByLabelText("Tenant")).toBeInTheDocument();

    cleanup();
    stubApi(NOT_CONNECTED);
    renderPage("prometheus");
    await screen.findByLabelText("Query URL");
    expect(screen.queryByLabelText("Tenant")).not.toBeInTheDocument();
  });

  /* One credential reaches the source: the API returns the header and drops a
     basic pair sent beside it, so the form must never send both. */
  it("sends only the credential the chosen method names", async () => {
    const user = userEvent.setup();
    const posted = stubApi(NOT_CONNECTED);
    renderPage("mimir");

    await user.type(await screen.findByLabelText("Username"), "123456");
    await user.type(screen.getByLabelText("Password"), "glc-token");
    await user.type(
      screen.getByLabelText("Query URL"),
      "http://mimir:8080/prometheus",
    );

    await user.click(screen.getByRole("combobox", { name: "Authentication" }));
    await user.click(
      await screen.findByRole("option", { name: "Bearer token" }),
    );
    await user.type(
      await screen.findByLabelText("Authorization header"),
      "Bearer abc",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      kind: "mimir",
      query: { url: "http://mimir:8080/prometheus", authHeader: "Bearer abc" },
    });
  });
});
