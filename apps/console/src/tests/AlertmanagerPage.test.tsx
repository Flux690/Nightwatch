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
import type { RunnerRecord } from "@nightwatch/shared";

import { AlertmanagerPage } from "../pages/AlertmanagerPage.js";

const INGEST_TOKEN = "nwi_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345";
const ROTATED_TOKEN = "nwi_rotated999999999999999999999999";
const INGEST_URL = "http://api.test/alerts/ingest";

function dockerRunner(name: string): RunnerRecord {
  return {
    id: name,
    token: name,
    serverName: name,
    hostname: `${name}-host`,
    createdAt: "2024-01-01T00:00:00Z",
    online: true,
    lastSeen: new Date().toISOString(),
    manifest: {
      hostname: `${name}-host`,
      runnerVersion: "2.0.0",
      capabilities: {
        docker: true,
        kubernetes: false,
        services: [],
        postgres: { available: false },
        redis: { available: false },
        hostMetrics: true,
        fileRead: true,
        remediationEnabled: false,
      },
    },
    remediationMode: false,
  };
}

const MATCHED_VALIDATE = {
  alerts: [
    {
      sourceAlertId: "sample",
      identityKey: "docker/prod-web-01/sample-service/sample-service",
      advertisedOn: ["prod-web-01"],
      exactMatch: true,
    },
  ],
};

function jsonOk(body: unknown, status = 200) {
  return Promise.resolve({
    ok: true,
    status,
    json: () => Promise.resolve(body),
  });
}

function renderAlertmanagerRoute() {
  const rootRoute = createRootRoute();
  const alertmanagerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/alertmanager",
    component: AlertmanagerPage,
  });
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([alertmanagerRoute, integrationsRoute]),
    history: createMemoryHistory({
      initialEntries: ["/integrations/alertmanager"],
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
    configured?: boolean;
    lastReceivedAt?: string | null;
    runners?: RunnerRecord[];
    validate?: unknown;
  } = {},
) {
  const {
    configured = false,
    lastReceivedAt = null,
    runners = [dockerRunner("prod-web-01")],
    validate = MATCHED_VALIDATE,
  } = opts;
  let rotated = false;

  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });

  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/runners") return jsonOk(runners);
      if (url === "/api/ingest-credential" && init?.method === "POST") {
        rotated = true;
        return jsonOk({ token: ROTATED_TOKEN }, 201);
      }
      if (url === "/api/ingest-credential/reveal" && init?.method === "POST")
        return jsonOk({ token: INGEST_TOKEN });
      if (url === "/api/ingest-credential")
        return jsonOk({
          configured: configured || rotated,
          ingestUrl: INGEST_URL,
          lastReceivedAt: rotated ? null : lastReceivedAt,
        });
      if (url === "/api/alerts/validate" && init?.method === "POST")
        return jsonOk(validate);
      return jsonOk({});
    });
  vi.stubGlobal("fetch", fetchMock);

  const view = renderAlertmanagerRoute();
  return { fetchMock, clipboardWrite, view };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AlertmanagerPage", () => {
  it("unconfigured: mints only on demand, then shows the receiver with the real token", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ configured: false });

    const setUpButton = await screen.findByRole("button", {
      name: /set up alert forwarding/i,
    });
    // Viewing the page must never create a secret.
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/ingest-credential",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.queryByText(/receivers:/)).not.toBeInTheDocument();

    await user.click(setUpButton);
    await waitFor(() => {
      expect(
        screen.getAllByText(new RegExp(ROTATED_TOKEN)).length,
      ).toBeGreaterThan(0);
    });
    expect(
      screen.getByRole("button", { name: /copy alertmanager receiver/i }),
    ).toBeInTheDocument();
  });

  it("configured: receiver stays visible with a masked token until Show token, which also enables the test", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ configured: true });

    await screen.findByText(/waiting for first alert/i);
    // The YAML structure is always on the page; only the secret is masked.
    expect(screen.getByText(/receivers:/)).toBeInTheDocument();
    expect(screen.getByText(/••••••••/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /copy alertmanager receiver/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /test webhook/i }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /show token/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ingest-credential/reveal",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(
      screen.getAllByText(new RegExp(INGEST_TOKEN)).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /copy alertmanager receiver/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /test webhook/i }),
    ).toBeEnabled();
  });

  it("delivery state: Receiving with a relative time once an alert has landed", async () => {
    setup({
      configured: true,
      lastReceivedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });

    expect(await screen.findByText(/receiving/i)).toBeInTheDocument();
    expect(screen.getByText(/last alert 2h ago/i)).toBeInTheDocument();
  });

  it("rotating swaps the new token into the receiver and regresses status to waiting", async () => {
    const user = userEvent.setup();
    setup({
      configured: true,
      lastReceivedAt: "2026-07-17T01:00:00.000Z",
    });

    await user.click(await screen.findByRole("button", { name: /show token/i }));
    await waitFor(() => {
      expect(
        screen.getAllByText(new RegExp(INGEST_TOKEN)).length,
      ).toBeGreaterThan(0);
    });

    await user.click(
      screen.getByRole("button", { name: /rotate credential/i }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByText(new RegExp(ROTATED_TOKEN)).length,
      ).toBeGreaterThan(0);
    });
    expect(
      screen.queryByText(new RegExp(INGEST_TOKEN)),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByText(/waiting for first alert/i),
    ).toBeInTheDocument();
  });

  it("test webhook posts the nw_server-labelled sample with the credential and shows the fleet match", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ configured: true });

    await user.click(await screen.findByRole("button", { name: /show token/i }));
    await user.click(
      await screen.findByRole("button", { name: /test webhook/i }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/alerts/validate",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: `Bearer ${INGEST_TOKEN}`,
          }),
        }),
      );
    });
    const validateCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/alerts/validate",
    )!;
    expect(String((validateCall[1] as RequestInit).body)).toContain(
      '"nw_server":"prod-web-01"',
    );
    expect(
      await screen.findByText(/resolved to one server/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/advertised on prod-web-01/i)).toBeInTheDocument();
  });

  it("an unmatched sample explains the fleet-map triage instead of claiming failure", async () => {
    const user = userEvent.setup();
    setup({
      configured: true,
      validate: {
        alerts: [
          {
            sourceAlertId: "sample",
            identityKey: "docker/sample-service/sample-service",
            advertisedOn: [],
            exactMatch: false,
          },
        ],
      },
    });

    await user.click(await screen.findByRole("button", { name: /show token/i }));
    await user.click(
      await screen.findByRole("button", { name: /test webhook/i }),
    );

    expect(await screen.findByText(/no exact match/i)).toBeInTheDocument();
    expect(
      screen.getByText(/the agent triages it from the fleet map/i),
    ).toBeInTheDocument();
  });

  it("routing section is hidden with no docker servers and a one-liner with one", async () => {
    const { view } = setup({ configured: true, runners: [] });
    await screen.findByText(/waiting for first alert/i);
    expect(screen.queryByText(/nw_server/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^server$/i)).not.toBeInTheDocument();
    view.unmount();
    vi.unstubAllGlobals();

    setup({ configured: true, runners: [dockerRunner("prod-web-01")] });
    expect(
      await screen.findByText(/alerts resolve to it automatically/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^server$/i)).not.toBeInTheDocument();
  });

  it("with two servers: dropdown of runner names drives the per-target snippet, external_labels as the aside", async () => {
    const user = userEvent.setup();
    setup({
      configured: true,
      runners: [dockerRunner("prod-web-01"), dockerRunner("prod-web-02")],
    });

    expect(
      await screen.findByText(/say which server they're about/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/nw_server: "prod-web-01"/)).toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText(/^server$/i),
      "prod-web-02",
    );
    expect(screen.getByText(/nw_server: "prod-web-02"/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy prometheus labels/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/set it once instead/i)).toBeInTheDocument();
  });
});
