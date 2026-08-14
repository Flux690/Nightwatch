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
import type { AlertSourceKind, RunnerRecord } from "@nightwarden/shared";

import { AlertSourcePage } from "../pages/AlertSourcePage.js";

const INGEST_TOKEN = "nwi_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345";
const ROTATED_TOKEN = "nwi_rotated999999999999999999999999";
const INGEST_URL = "http://api.test/alerts/ingest";

function dockerRunner(name: string): RunnerRecord {
  return {
    id: name,
    token: name,
    platform: "docker" as const,
    serverName: name,
    hostname: `${name}-host`,
    createdAt: "2024-01-01T00:00:00Z",
    online: true,
    lastSeen: new Date().toISOString(),
    manifest: {
      platform: "docker" as const,
      hostname: `${name}-host`,
      runnerVersion: "2.0.0",
      services: [],
    },
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

function renderAlertmanagerRoute(kind: AlertSourceKind = "alertmanager") {
  const rootRoute = createRootRoute();
  const alertmanagerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/alerting/alertmanager",
    component: () => <AlertSourcePage kind={kind} />,
  });
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([alertmanagerRoute, integrationsRoute]),
    history: createMemoryHistory({
      initialEntries: ["/integrations/alerting/alertmanager"],
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
    kind?: AlertSourceKind;
  } = {},
) {
  const {
    configured = false,
    lastReceivedAt = null,
    runners = [dockerRunner("prod-web-01")],
    validate = MATCHED_VALIDATE,
    kind = "alertmanager",
  } = opts;
  const base = `/api/integrations/alerting/${kind}`;
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
      if (url === `${base}/credential` && init?.method === "POST") {
        rotated = true;
        return jsonOk({ token: ROTATED_TOKEN }, 201);
      }
      if (url === `${base}/credential/reveal` && init?.method === "POST")
        return jsonOk({ token: INGEST_TOKEN });
      if (url === base)
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

  const view = renderAlertmanagerRoute(kind);
  return { fetchMock, clipboardWrite, view };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AlertSourcePage", () => {
  it("unconfigured: previews the masked receiver, mints only on demand, then fills in the real token", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ configured: false });

    const generateButton = await screen.findByRole("button", {
      name: /generate credential/i,
    });
    // The full setup layout is visible up front; viewing it never creates a secret.
    expect(screen.getByText(/receivers:/)).toBeInTheDocument();
    expect(screen.getByText(/••••••••/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/integrations/alerting/alertmanager/credential",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      screen.queryByRole("button", { name: /copy alertmanager receiver/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /test webhook/i }),
    ).not.toBeInTheDocument();

    await user.click(generateButton);
    await waitFor(() => {
      expect(
        screen.getAllByText(new RegExp(ROTATED_TOKEN)).length,
      ).toBeGreaterThan(0);
    });
    expect(
      screen.getByRole("button", { name: /copy alertmanager receiver/i }),
    ).toBeInTheDocument();
    // Mid-setup is steps, not a status report: no waiting badge yet.
    expect(
      screen.queryByText(/waiting for first alert/i),
    ).not.toBeInTheDocument();
  });

  it("configured: receiver stays visible with a masked token until Show token", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ configured: true });

    await screen.findByText(/waiting for first alert/i);
    // The YAML structure is always on the page; only the secret is masked.
    expect(screen.getByText(/receivers:/)).toBeInTheDocument();
    expect(screen.getByText(/••••••••/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /copy alertmanager receiver/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /show token/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations/alerting/alertmanager/credential/reveal",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(
      screen.getAllByText(new RegExp(INGEST_TOKEN)).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /copy alertmanager receiver/i }),
    ).toBeInTheDocument();
    // Revealing is not setup: the status line stays put, no layout jump.
    expect(screen.getByText(/waiting for first alert/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /hide token/i }));
    expect(screen.getByText(/••••••••/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /copy alertmanager receiver/i }),
    ).not.toBeInTheDocument();
  });

  // One page serves every sender, so the setup and the settings that fail
  // silently both have to come from the kind rather than from Alertmanager.
  it("renders each sender's own setup and its own quiet failures", async () => {
    const { view } = setup({ configured: true });
    await screen.findByText(/waiting for first alert/i);
    expect(
      screen.getByText(/send_resolved at its default/),
    ).toBeInTheDocument();
    view.unmount();
    vi.unstubAllGlobals();

    setup({ kind: "grafana", configured: true });
    await screen.findByText(/waiting for first alert/i);
    expect(screen.getByText(/Contact points/)).toBeInTheDocument();
    // A contact point is a form, so no alertmanager.yml is offered.
    expect(screen.queryByText(/receivers:/)).not.toBeInTheDocument();
    expect(screen.getByText(/Custom Payload empty/)).toBeInTheDocument();
    expect(
      screen.getByText(/Disable resolved message off/),
    ).toBeInTheDocument();
  });

  it("delivery state: Receiving with a relative time once an alert has landed", async () => {
    setup({
      configured: true,
      lastReceivedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });

    expect(await screen.findByText(/receiving/i)).toBeInTheDocument();
    expect(screen.getByText(/last alert 2h ago/i)).toBeInTheDocument();
  });

  it("rotating confirms in a dialog, swaps the new token in place, and drops back to setup mode", async () => {
    const user = userEvent.setup();
    setup({
      configured: true,
      lastReceivedAt: "2026-07-17T01:00:00.000Z",
    });

    await user.click(
      await screen.findByRole("button", { name: /show token/i }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByText(new RegExp(INGEST_TOKEN)).length,
      ).toBeGreaterThan(0);
    });

    // The consequence lives in the dialog, not inline; nothing mints until confirmed.
    await user.click(
      screen.getByRole("button", { name: /rotate credential/i }),
    );
    expect(
      await screen.findByText(/stops delivering until you paste/i),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(new RegExp(INGEST_TOKEN)).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /^rotate$/i }));
    await waitFor(() => {
      expect(
        screen.getAllByText(new RegExp(ROTATED_TOKEN)).length,
      ).toBeGreaterThan(0);
    });
    expect(
      screen.queryByText(new RegExp(INGEST_TOKEN)),
    ).not.toBeInTheDocument();
    // Post-rotate the user is mid-setup again: steps, no status line.
    expect(
      screen.queryByText(/waiting for first alert/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/receiving/i)).not.toBeInTheDocument();
  });
});
