import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { TestProviders } from "./renderWithProviders.js";
import type { RunnerRecord } from "@nightwarden/shared";

import { AddRunnerPage } from "../pages/AddRunnerPage.js";

const GENERATED_TOKEN = {
  id: "new-token-uuid",
  token: "nwr_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345",
  label: null,
  createdAt: new Date().toISOString(),
};

const CONNECT_SCRIPT = "#!/bin/sh\necho install-docker";
const MANIFEST_YAML = "kind: Deployment\nname: nightwarden-runner";

const AWAITING_RUNNER: RunnerRecord = {
  id: "new-token-uuid",
  token: "new-token-uuid",
  serverName: null,
  hostname: null,
  createdAt: "2024-01-01T00:00:00Z",
  online: false,
  lastSeen: null,
  manifest: null,
};

const CONNECTED_RUNNER: RunnerRecord = {
  id: "new-token-uuid",
  token: "new-token-uuid",
  serverName: null,
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date().toISOString(),
  manifest: null,
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

/* The page is a routed screen with a navigation guard, so the seam under test is the route:
   a memory router with a stub runner-servers destination. The layout link stands
   in for the shell's rail navigation (the page has no back-link of its own). */
function renderAddServerRoute() {
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Link to="/integrations">Integrations</Link>
        <Outlet />
      </>
    ),
  });
  const addRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/docker/add",
    component: () => <AddRunnerPage substrate="docker" />,
  });
  const runnerServersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/docker",
    component: () => <div>Runner servers destination</div>,
  });
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const alertmanagerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/alertmanager",
    component: () => <div>Alertmanager destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      addRoute,
      runnerServersRoute,
      integrationsRoute,
      alertmanagerRoute,
    ]),
    history: createMemoryHistory({
      initialEntries: ["/integrations/docker/add"],
    }),
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
      if (url === "/api/alerts/test" && init?.method === "POST")
        return jsonOk({
          ok: true,
          runnerId: "runner-web-01",
          server: "web-01",
        });
      return jsonOk({});
    });
  vi.stubGlobal("fetch", fetchMock);

  return { fetchMock, ...renderAddServerRoute() };
}

// The substrate comes from the route, so the first step only asks for a name.
async function startInstall(
  user: ReturnType<typeof userEvent.setup>,
  opts: { name?: string } = {},
): Promise<void> {
  const { name = "test-runner" } = opts;
  await user.type(
    await screen.findByRole("textbox", { name: /display name/i }),
    name,
  );
  await user.click(screen.getByRole("button", { name: /continue/i }));
}

async function advanceToVerify(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await startInstall(user);
  await waitFor(() => {
    expect(screen.getByText(/runner connected/i)).toBeInTheDocument();
  });
  await user.click(screen.getByRole("button", { name: /continue/i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AddRunnerPage", () => {
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

  describe("verify step", () => {
    it("navigates back to the runner servers list via the Done button", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });
      await advanceToVerify(user);

      await user.click(screen.getByRole("button", { name: /done/i }));

      expect(
        await screen.findByText(/runner servers destination/i),
      ).toBeInTheDocument();
    });

    it("lists the identity keys the runner advertises, dispatching nothing", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({
        runners: [
          {
            ...CONNECTED_RUNNER,
            manifest: {
              hostname: "web-host",
              runnerVersion: "2.0.0",
              capabilities: {
                docker: true,
                kubernetes: false,
                services: [
                  {
                    identity: {
                      provider: "docker",
                      project: "encodr",
                      service: "cache",
                    },
                    status: "running",
                  },
                ],
                postgres: { available: false },
                redis: { available: false },
              },
            },
          },
        ],
      });
      await advanceToVerify(user);

      expect(screen.getByText("docker/encodr/cache")).toBeInTheDocument();

      // Checking the wiring must not start an investigation or spend a token.
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/alerts/test",
        expect.anything(),
      );
    });

    it("warns when the runner connected but sees nothing", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });
      await advanceToVerify(user);

      expect(screen.getByText(/no services detected/i)).toBeInTheDocument();
    });

    it("confirms, deletes the minted token, and navigates when leaving before the runner connects", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [AWAITING_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("link", { name: /integrations/i }));

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
      expect(
        await screen.findByText(/integrations destination/i),
      ).toBeInTheDocument();
    });

    it("stays on the page and keeps the token when the leave prompt is declined", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [AWAITING_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("link", { name: /integrations/i }));

      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: /^cancel$/i }),
      );

      expect(
        screen.getByRole("heading", { name: /add a docker host/i }),
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

      await user.click(screen.getByRole("link", { name: /integrations/i }));

      expect(
        await screen.findByText(/integrations destination/i),
      ).toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/tokens/"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
