import { render, screen, waitFor, within } from "@testing-library/react";
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

import { AddServerPage } from "../pages/AddServerPage.js";

const GENERATED_TOKEN = {
  id: "new-token-uuid",
  token: "nwr_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345",
  label: null,
  createdAt: new Date().toISOString(),
};

const CONNECT_SCRIPT = "#!/bin/sh\necho install-docker";
const MANIFEST_YAML = "kind: Deployment\nname: nightwatch-runner";
const INGEST_TOKEN = "nwi_fleettoken456";
const INGEST_URL = "http://api.test/alerts/ingest";

const AWAITING_RUNNER: RunnerRecord = {
  id: "new-token-uuid",
  token: "new-token-uuid",
  hostname: null,
  createdAt: "2024-01-01T00:00:00Z",
  online: false,
  lastSeen: null,
  manifest: null,
  remediationMode: null,
};

const CONNECTED_RUNNER: RunnerRecord = {
  id: "new-token-uuid",
  token: "new-token-uuid",
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
        runnerId: "runner-web-01",
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

function textOk(body: string) {
  return Promise.resolve({ ok: true, text: () => Promise.resolve(body) });
}

/* The page is a routed screen with a navigation guard, so the seam under
   test is the route: a memory router with a stub /fleet destination. */
function renderAddServerRoute() {
  const rootRoute = createRootRoute();
  const addRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/fleet/add",
    component: AddServerPage,
  });
  const fleetRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/fleet",
    component: () => <div>Fleet destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([addRoute, fleetRoute]),
    history: createMemoryHistory({ initialEntries: ["/fleet/add"] }),
  });

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const view = render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </TestProviders>,
  );

  return { router, ...view };
}

function setup(opts: { runners?: RunnerRecord[] } = {}) {
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });

  const runners = opts.runners ?? [AWAITING_RUNNER];

  const fetchMock = vi
    .fn()
    .mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/runners") return jsonOk(runners);
      if (url === "/api/tokens" && init?.method === "POST")
        return jsonOk(GENERATED_TOKEN, 201);
      if (url.startsWith("/api/tokens/") && init?.method === "DELETE")
        return jsonOk({}, 204);
      if (url === "/api/connect.sh") return textOk(CONNECT_SCRIPT);
      if (url === "/api/manifest.yaml") return textOk(MANIFEST_YAML);
      if (url === "/api/ingest-credential/ensure" && init?.method === "POST")
        return jsonOk({ token: INGEST_TOKEN, ingestUrl: INGEST_URL });
      if (url === "/api/alerts/test" && init?.method === "POST")
        return jsonOk({
          ok: true,
          runnerId: "runner-web-01",
          hostname: "web-01",
        });
      if (url === "/api/alerts/validate" && init?.method === "POST")
        return jsonOk(RESOLVED_VALIDATE);
      return jsonOk({});
    });
  vi.stubGlobal("fetch", fetchMock);

  return { fetchMock, ...renderAddServerRoute() };
}

type Monitoring = "bundled" | "byo";

async function fillServerStep(
  user: ReturnType<typeof userEvent.setup>,
  opts: {
    provider?: "docker" | "kubernetes";
    name?: string;
    monitoring?: Monitoring;
  } = {},
): Promise<void> {
  const {
    provider = "docker",
    name = "test-server",
    monitoring = "bundled",
  } = opts;
  await user.click(
    await screen.findByRole("radio", {
      name: provider === "docker" ? /docker/i : /kubernetes/i,
    }),
  );
  await user.type(screen.getByRole("textbox", { name: /server name/i }), name);
  await user.click(
    screen.getByRole("radio", {
      name:
        monitoring === "bundled" ? /bundle prometheus/i : /my own monitoring/i,
    }),
  );
}

async function startInstall(
  user: ReturnType<typeof userEvent.setup>,
  opts?: {
    provider?: "docker" | "kubernetes";
    name?: string;
    monitoring?: Monitoring;
  },
): Promise<void> {
  await fillServerStep(user, opts);
  await user.click(screen.getByRole("button", { name: /continue/i }));
}

async function advanceToVerify(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await startInstall(user, { monitoring: "bundled" });
  await waitFor(() => {
    expect(screen.getByText(/runner connected/i)).toBeInTheDocument();
  });
  await user.click(screen.getByRole("button", { name: /continue/i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AddServerPage", () => {
  describe("install step", () => {
    it("mints a runner token and shows the docker run script", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();

      await startInstall(user, { name: "web-01" });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/tokens",
          expect.objectContaining({ method: "POST" }),
        );
      });
      await waitFor(() => {
        expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      });
    });

    it("includes serverName in the token mint request", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();

      await startInstall(user, { name: "prod-web-01" });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/tokens",
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining('"prod-web-01"'),
          }),
        );
      });
    });

  });

  describe("bring-your-own monitoring", () => {
    it("shows the fleet ingest credential and webhook config inline, no reveal step", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { monitoring: "byo" });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/ingest-credential/ensure",
          expect.objectContaining({ method: "POST" }),
        );
      });
      await waitFor(() => {
        expect(
          screen.getAllByText(new RegExp(INGEST_TOKEN)).length,
        ).toBeGreaterThan(0);
      });
      // The server-provided webhook URL is shown plainly, not window.location.
      expect(
        screen.getAllByText(new RegExp(INGEST_URL.replace(/\//g, "\\/")))
          .length,
      ).toBeGreaterThan(0);
      expect(
        screen.queryByRole("button", { name: /reveal/i }),
      ).not.toBeInTheDocument();
    });

    it("tests the webhook with the inline credential and shows the resolved result", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { monitoring: "byo" });
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

    it("shows the rejection reason when the test payload doesn't match the fleet", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          if (url === "/api/runners") return jsonOk([CONNECTED_RUNNER]);
          if (url === "/api/tokens" && init?.method === "POST")
            return jsonOk(GENERATED_TOKEN, 201);
          if (url === "/api/connect.sh") return textOk(CONNECT_SCRIPT);
          if (
            url === "/api/ingest-credential/ensure" &&
            init?.method === "POST"
          )
            return jsonOk({ token: INGEST_TOKEN, ingestUrl: INGEST_URL });
          if (url === "/api/alerts/validate")
            return jsonOk({
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
            });
          return jsonOk({});
        }),
      );

      await startInstall(user, { monitoring: "byo" });
      await user.click(
        await screen.findByRole("button", { name: /test webhook/i }),
      );

      await waitFor(() => {
        expect(screen.getByText(/no runner advertises/i)).toBeInTheDocument();
      });
    });
  });

  describe("verify step", () => {
    it("navigates back to the fleet via the Done button", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });
      await advanceToVerify(user);

      await user.click(screen.getByRole("button", { name: /done/i }));

      expect(await screen.findByText(/fleet destination/i)).toBeInTheDocument();
    });

    it("sends a test alert and reports success once the pipeline confirms", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [CONNECTED_RUNNER] });
      await advanceToVerify(user);

      await user.click(
        screen.getByRole("button", { name: /send test alert/i }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/alerts/test",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ runnerId: "new-token-uuid" }),
          }),
        );
      });
      await waitFor(() => {
        expect(screen.getByText(/pipeline verified/i)).toBeInTheDocument();
      });
    });

    it("shows an error when the test alert fails", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          if (url === "/api/runners") return jsonOk([CONNECTED_RUNNER]);
          if (url === "/api/tokens" && init?.method === "POST")
            return jsonOk(GENERATED_TOKEN, 201);
          if (url === "/api/connect.sh") return textOk(CONNECT_SCRIPT);
          if (url === "/api/alerts/test")
            return Promise.resolve({
              ok: false,
              status: 404,
              json: () => Promise.resolve({ error: "runner not connected" }),
            });
          return jsonOk({});
        }),
      );

      await advanceToVerify(user);
      await user.click(
        screen.getByRole("button", { name: /send test alert/i }),
      );

      await waitFor(() => {
        expect(screen.getByText(/runner not connected/i)).toBeInTheDocument();
      });
    });
  });

  describe("token hygiene on leaving the page", () => {
    it("confirms, deletes the minted token, and navigates when leaving before the runner connects", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [AWAITING_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("link", { name: /fleet/i }));

      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: /^leave setup$/i }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/tokens/${GENERATED_TOKEN.id}`,
          expect.objectContaining({ method: "DELETE" }),
        );
      });
      expect(await screen.findByText(/fleet destination/i)).toBeInTheDocument();
    });

    it("stays on the page and keeps the token when the leave prompt is declined", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [AWAITING_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("link", { name: /fleet/i }));

      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: /^cancel$/i }),
      );

      expect(
        screen.getByRole("heading", { name: /add a server/i }),
      ).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/tokens/"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("leaves without a prompt and keeps the token once the runner has connected", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(screen.getByText(/runner connected/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("link", { name: /fleet/i }));

      expect(await screen.findByText(/fleet destination/i)).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/tokens/"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
