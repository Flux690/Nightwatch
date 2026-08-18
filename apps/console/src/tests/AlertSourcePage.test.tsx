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
      if (url === base && init?.method === "DELETE") return jsonOk({}, 204);
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
  it("shows the whole setup without minting, then reveals the credential once", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ configured: false });

    const generateButton = await screen.findByRole("button", {
      name: /generate credential/i,
    });
    // Viewing the setup never creates a secret, and the block carries a
    // placeholder rather than a live one - it is safe to copy anywhere.
    expect(screen.getByText(/receivers:/)).toBeInTheDocument();
    expect(screen.getByText(/paste your credential here/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/integrations/alerting/alertmanager/credential",
      expect.objectContaining({ method: "POST" }),
    );

    await user.click(generateButton);

    await screen.findByText(new RegExp(ROTATED_TOKEN));
    expect(screen.getByText(/not shown again/i)).toBeInTheDocument();
    // The block still carries the placeholder: the secret lives on its own.
    expect(screen.getByText(/paste your credential here/)).toBeInTheDocument();
    // Mid-setup is steps, not a status report: no waiting badge yet.
    expect(
      screen.queryByText(/waiting for first alert/i),
    ).not.toBeInTheDocument();
  });

  it("hides the credential for good once it has been saved, offering no way back", async () => {
    const user = userEvent.setup();
    setup({ configured: false });

    await user.click(
      await screen.findByRole("button", { name: /generate credential/i }),
    );
    await screen.findByText(new RegExp(ROTATED_TOKEN));

    await user.click(screen.getByRole("button", { name: /i've saved it/i }));

    await waitFor(() => {
      expect(
        screen.queryByText(new RegExp(ROTATED_TOKEN)),
      ).not.toBeInTheDocument();
    });
    // Nothing on the page can fetch it back; rotating is the only way to a
    // working credential again.
    expect(
      screen.queryByRole("button", { name: /show token/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /rotate credential/i }),
    ).toBeInTheDocument();
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

  it("rotating confirms in a dialog, then shows the new credential once", async () => {
    const user = userEvent.setup();
    setup({ configured: true, lastReceivedAt: "2026-07-17T01:00:00.000Z" });

    // The consequence lives in the dialog; nothing mints until confirmed.
    await user.click(
      await screen.findByRole("button", { name: /rotate credential/i }),
    );
    expect(
      await screen.findByText(/stops delivering until you paste/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(ROTATED_TOKEN)),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^rotate$/i }));

    await screen.findByText(new RegExp(ROTATED_TOKEN));
    expect(screen.getByText(/not shown again/i)).toBeInTheDocument();
    // Post-rotate the user is mid-setup again: steps, no status line.
    expect(
      screen.queryByText(/waiting for first alert/i),
    ).not.toBeInTheDocument();
  });

  it("disconnects, which is the revoke the page never had", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ configured: true });

    await user.click(
      await screen.findByRole("button", { name: /disconnect/i }),
    );
    await user.click(screen.getByRole("button", { name: /^disconnect$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/integrations/alerting/alertmanager",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
