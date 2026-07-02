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
  it("renders the title and a back link to the fleet", async () => {
    setup();
    expect(
      await screen.findByRole("heading", { name: /add a server/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /fleet/i })).toBeInTheDocument();
  });

  describe("server step", () => {
    it("shows provider selection as the first step", async () => {
      setup();
      expect(
        await screen.findByRole("radio", { name: /docker/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("radio", { name: /kubernetes/i }),
      ).toBeInTheDocument();
    });

    it("requires provider, name, and a monitoring choice before Continue is enabled", async () => {
      const user = userEvent.setup();
      setup();

      await user.click(await screen.findByRole("radio", { name: /docker/i }));
      expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();

      await user.type(
        screen.getByRole("textbox", { name: /server name/i }),
        "web-01",
      );
      expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();

      await user.click(
        screen.getByRole("radio", { name: /bundle prometheus/i }),
      );
      expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
    });

    it("shows a validation error when the server name contains a forward slash", async () => {
      const user = userEvent.setup();
      setup();

      await user.click(await screen.findByRole("radio", { name: /docker/i }));
      await user.type(
        screen.getByRole("textbox", { name: /server name/i }),
        "prod/web",
      );

      expect(screen.getByText(/must not contain/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    });
  });

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

    it("mints a runner token and shows the Kubernetes manifest", async () => {
      const user = userEvent.setup();
      setup();

      await startInstall(user, { provider: "kubernetes", name: "k8s-cluster" });

      await waitFor(() => {
        expect(screen.getByText(/nightwatch-runner/)).toBeInTheDocument();
      });
    });

    it("shows an awaiting-connection state while the runner has not connected", async () => {
      const user = userEvent.setup();
      setup({ runners: [AWAITING_RUNNER] });

      await startInstall(user, { name: "web-01" });

      await waitFor(() => {
        expect(screen.getByText(/waiting for/i)).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    });

    it("enables Continue once the runner connects", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { name: "web-01" });

      await waitFor(() => {
        expect(screen.getByText(/runner connected/i)).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
    });

    it("shows the bundled note and no credential panel for the bundled choice", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { monitoring: "bundled" });

      await waitFor(() => {
        expect(screen.getByText(/monitoring bundled/i)).toBeInTheDocument();
      });
      expect(
        screen.queryByText(new RegExp(INGEST_TOKEN)),
      ).not.toBeInTheDocument();
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

    it("stamps the chosen server name into the Prometheus server-label snippet", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { name: "prod-web-01", monitoring: "byo" });

      await waitFor(() => {
        expect(screen.getByText(/in your prometheus/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/prod-web-01/)).toBeInTheDocument();
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
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      const { fetchMock } = setup({ runners: [AWAITING_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("link", { name: /fleet/i }));

      expect(confirmSpy).toHaveBeenCalledTimes(1);
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
      vi.spyOn(window, "confirm").mockReturnValue(false);
      const { fetchMock } = setup({ runners: [AWAITING_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("link", { name: /fleet/i }));

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
      const confirmSpy = vi.spyOn(window, "confirm");
      const { fetchMock } = setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(screen.getByText(/runner connected/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("link", { name: /fleet/i }));

      expect(await screen.findByText(/fleet destination/i)).toBeInTheDocument();
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/tokens/"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
