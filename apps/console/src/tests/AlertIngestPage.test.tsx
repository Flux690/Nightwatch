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

import { AlertIngestPage } from "../pages/AlertIngestPage.js";

const INGEST_TOKEN = "nwi_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345";
const INGEST_URL = "http://api.test/alerts/ingest";

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

const RESOLVED_VALIDATE = {
  alerts: [
    {
      sourceAlertId: "sample",
      identityKey: "docker/sample-service/sample-service",
      resolution: {
        status: "resolved",
        runnerId: "runner-1",
        hostname: "web-01",
      },
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

function renderAlertIngestRoute() {
  const rootRoute = createRootRoute();
  const alertIngestRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/alert-ingest",
    component: AlertIngestPage,
  });
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([alertIngestRoute, integrationsRoute]),
    history: createMemoryHistory({
      initialEntries: ["/integrations/alert-ingest"],
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

function setup(opts: { configured?: boolean; validate?: unknown } = {}) {
  const { configured = false, validate = RESOLVED_VALIDATE } = opts;

  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });

  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/runners") return jsonOk([CONNECTED_RUNNER]);
      if (url === "/api/ingest-credential/ensure" && init?.method === "POST")
        return jsonOk({ token: INGEST_TOKEN, ingestUrl: INGEST_URL });
      if (url === "/api/ingest-credential/reveal" && init?.method === "POST")
        return jsonOk({ token: INGEST_TOKEN });
      if (url === "/api/ingest-credential" && init?.method === "POST")
        return jsonOk({ token: INGEST_TOKEN }, 201);
      if (url === "/api/ingest-credential") return jsonOk({ configured });
      if (url === "/api/alerts/validate" && init?.method === "POST")
        return jsonOk(validate);
      return jsonOk({});
    });
  vi.stubGlobal("fetch", fetchMock);

  renderAlertIngestRoute();
  return { fetchMock, clipboardWrite };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AlertIngestPage", () => {
  describe("webhook wiring", () => {
    it("shows the webhook URL and a ready-to-paste Alertmanager receiver", async () => {
      const { fetchMock } = setup();

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/ingest-credential/ensure",
          expect.objectContaining({ method: "POST" }),
        );
      });
      // The server-provided webhook URL is shown plainly, not window.location.
      await waitFor(() => {
        expect(
          screen.getAllByText(new RegExp(INGEST_URL.replace(/\//g, "\\/")))
            .length,
        ).toBeGreaterThan(0);
      });
      expect(
        screen.getByRole("button", { name: /copy alertmanager receiver/i }),
      ).toBeInTheDocument();
    });

    it("offers the server-label snippet prefilled from a connected server", async () => {
      setup();
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /copy prometheus config/i }),
        ).toBeInTheDocument();
      });
      expect(screen.getByText(/server: "prod-web-01"/)).toBeInTheDocument();
    });
  });

  describe("ingest credential", () => {
    it("fetches the credential status on load", async () => {
      const { fetchMock } = setup();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/ingest-credential");
      });
    });

    it("POSTs the credential and shows the plaintext once on Generate", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ configured: false });

      await user.click(
        await screen.findByRole("button", { name: /generate credential/i }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/ingest-credential",
          expect.objectContaining({ method: "POST" }),
        );
      });
      expect(screen.getByText(/no longer works/i)).toBeInTheDocument();
    });

    it("reveals the credential on demand via POST /reveal when configured", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ configured: true });

      await user.click(
        await screen.findByRole("button", { name: /reveal credential/i }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/ingest-credential/reveal",
          expect.objectContaining({ method: "POST" }),
        );
      });
      // A revealed (not freshly minted) token does not claim the old one is dead.
      expect(screen.queryByText(/no longer works/i)).not.toBeInTheDocument();
    });
  });

  describe("test webhook", () => {
    it("posts a sample alert with the ingest credential and shows the resolution", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();

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
      await waitFor(() => {
        expect(screen.getByText(/resolved/i)).toBeInTheDocument();
      });
    });

    it("shows the rejection reason when the sample does not match the fleet", async () => {
      const user = userEvent.setup();
      setup({
        validate: {
          alerts: [
            {
              sourceAlertId: "sample",
              identityKey: "docker/sample-service/sample-service",
              resolution: {
                status: "rejected",
                reason:
                  "No runner advertises service 'docker/sample-service/sample-service'.",
              },
            },
          ],
        },
      });

      await user.click(
        await screen.findByRole("button", { name: /test webhook/i }),
      );

      await waitFor(() => {
        expect(screen.getByText(/no runner advertises/i)).toBeInTheDocument();
      });
    });
  });
});
