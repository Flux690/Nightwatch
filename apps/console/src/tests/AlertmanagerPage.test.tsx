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

function setup(opts: { configured?: boolean; validate?: unknown } = {}) {
  const { configured = false, validate = RESOLVED_VALIDATE } = opts;
  let rotated = false;

  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });

  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/runners") return jsonOk([CONNECTED_RUNNER]);
      if (url === "/api/ingest-credential" && init?.method === "POST") {
        rotated = true;
        return jsonOk({ token: ROTATED_TOKEN }, 201);
      }
      if (url === "/api/ingest-credential/reveal" && init?.method === "POST")
        return jsonOk({ token: INGEST_TOKEN });
      if (url === "/api/ingest-credential")
        return jsonOk({ configured: configured || rotated, ingestUrl: INGEST_URL });
      if (url === "/api/alerts/validate" && init?.method === "POST")
        return jsonOk(validate);
      return jsonOk({});
    });
  vi.stubGlobal("fetch", fetchMock);

  renderAlertmanagerRoute();
  return { fetchMock, clipboardWrite };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AlertmanagerPage", () => {
  describe("webhook wiring", () => {
    it("shows the server-provided webhook URL without minting a credential", async () => {
      const { fetchMock } = setup({ configured: false });

      await waitFor(() => {
        expect(
          screen.getAllByText(new RegExp(INGEST_URL.replace(/\//g, "\\/")))
            .length,
        ).toBeGreaterThan(0);
      });
      // Viewing the page must never create a secret.
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/ingest-credential",
        expect.objectContaining({ method: "POST" }),
      );
      expect(await screen.findByText(/not configured/i)).toBeInTheDocument();
    });

    it("withholds the receiver snippet until the credential is in hand", async () => {
      setup({ configured: true });

      await waitFor(() => {
        expect(screen.getByText(/reveal the credential/i)).toBeInTheDocument();
      });
      expect(
        screen.queryByRole("button", { name: /copy alertmanager receiver/i }),
      ).not.toBeInTheDocument();
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

  describe("credential", () => {
    it("generates on demand and fills the receiver with the new token", async () => {
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
      expect(await screen.findByText(/no longer works/i)).toBeInTheDocument();
      await waitFor(() => {
        expect(
          screen.getAllByText(new RegExp(ROTATED_TOKEN)).length,
        ).toBeGreaterThan(0);
      });
    });

    it("reveals on demand without claiming the old credential is dead", async () => {
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
      expect(screen.queryByText(/no longer works/i)).not.toBeInTheDocument();
    });

    it("rotating replaces the token in the receiver snippet, never leaving the dead one", async () => {
      const user = userEvent.setup();
      setup({ configured: true });

      await user.click(
        await screen.findByRole("button", { name: /reveal credential/i }),
      );
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
      expect(screen.queryByText(new RegExp(INGEST_TOKEN))).not.toBeInTheDocument();
    });
  });

  describe("test webhook", () => {
    it("is unavailable until the credential is in hand", async () => {
      setup({ configured: true });
      expect(
        await screen.findByRole("button", { name: /test webhook/i }),
      ).toBeDisabled();
    });

    it("posts a sample alert with the credential and shows the resolution", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ configured: true });

      await user.click(
        await screen.findByRole("button", { name: /reveal credential/i }),
      );
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
      expect(await screen.findByText(/resolved/i)).toBeInTheDocument();
    });

    it("shows the rejection reason when the sample does not match the fleet", async () => {
      const user = userEvent.setup();
      setup({
        configured: true,
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
        await screen.findByRole("button", { name: /reveal credential/i }),
      );
      await user.click(
        await screen.findByRole("button", { name: /test webhook/i }),
      );

      await waitFor(() => {
        expect(screen.getByText(/no runner advertises/i)).toBeInTheDocument();
      });
    });
  });
});
