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

const AWAITING_RUNNER: RunnerRecord = {
  id: "new-token-uuid",
  token: "new-token-uuid",
  serverName: null,
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
  serverName: null,
  hostname: "web-01",
  createdAt: "2024-01-01T00:00:00Z",
  online: true,
  lastSeen: new Date().toISOString(),
  manifest: null,
  remediationMode: false,
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
   a memory router with a stub runner-servers destination. */
function renderAddServerRoute() {
  const rootRoute = createRootRoute();
  const addRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/runner/add",
    component: AddServerPage,
  });
  const runnerServersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations/runner",
    component: () => <div>Runner servers destination</div>,
  });
  const integrationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/integrations",
    component: () => <div>Integrations destination</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      addRoute,
      runnerServersRoute,
      integrationsRoute,
    ]),
    history: createMemoryHistory({
      initialEntries: ["/integrations/runner/add"],
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

async function fillServerStep(
  user: ReturnType<typeof userEvent.setup>,
  opts: { provider?: "docker" | "kubernetes"; name?: string } = {},
): Promise<void> {
  const { provider = "docker", name = "test-server" } = opts;
  await user.click(
    await screen.findByRole("radio", {
      name: provider === "docker" ? /docker/i : /kubernetes/i,
    }),
  );
  await user.type(screen.getByRole("textbox", { name: /server name/i }), name);
}

async function startInstall(
  user: ReturnType<typeof userEvent.setup>,
  opts?: { provider?: "docker" | "kubernetes"; name?: string },
): Promise<void> {
  await fillServerStep(user, opts);
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
