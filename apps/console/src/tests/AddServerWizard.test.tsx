import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import type { RunnerRecord } from "@nightwatch/shared";

import { AddServerWizard } from "../pages/AddServerWizard.js";
import { theme, cssVariablesResolver } from "../theme.js";

const GENERATED_TOKEN = {
  id: "new-token-uuid",
  token: "nwr_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345",
  label: null,
  createdAt: new Date().toISOString(),
};

const CONNECT_SCRIPT = "#!/bin/sh\necho install-docker";
const MANIFEST_YAML = "kind: Deployment\nname: nightwatch-runner";
const REVEALED_INGEST = "nwi_revealedtoken456";

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
  id: "runner-web-01",
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
      if (url === "/api/ingest-credential/reveal" && init?.method === "POST")
        return jsonOk({ token: REVEALED_INGEST });
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

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const onClose = vi.fn();

  const view = render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      <QueryClientProvider client={qc}>
        <AddServerWizard opened onClose={onClose} />
      </QueryClientProvider>
    </MantineProvider>,
  );

  return { fetchMock, onClose, ...view };
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
    screen.getByRole("radio", {
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

describe("AddServerWizard", () => {
  it("renders nothing when not opened", () => {
    const qc = new QueryClient();
    render(
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="light"
      >
        <QueryClientProvider client={qc}>
          <AddServerWizard opened={false} onClose={() => {}} />
        </QueryClientProvider>
      </MantineProvider>,
    );
    expect(screen.queryByText(/add a server/i)).not.toBeInTheDocument();
  });

  describe("server step", () => {
    it("shows provider selection as the first step", () => {
      setup();
      expect(
        screen.getByRole("radio", { name: /docker/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("radio", { name: /kubernetes/i }),
      ).toBeInTheDocument();
    });

    it("requires provider, name, and a monitoring choice before Continue is enabled", async () => {
      const user = userEvent.setup();
      setup();

      await user.click(screen.getByRole("radio", { name: /docker/i }));
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

      await user.click(screen.getByRole("radio", { name: /docker/i }));
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
        screen.queryByRole("button", { name: /reveal ingest credential/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe("bring-your-own monitoring", () => {
    it("shows a relabel snippet with the chosen server name", async () => {
      const user = userEvent.setup();
      setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { name: "prod-web-01", monitoring: "byo" });

      await waitFor(() => {
        expect(screen.getByText(/instance/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/prod-web-01/)).toBeInTheDocument();
    });

    it("reveals the fleet ingest credential and shows the webhook config", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { monitoring: "byo" });

      await user.click(
        await screen.findByRole("button", {
          name: /reveal ingest credential/i,
        }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/ingest-credential/reveal",
          expect.objectContaining({ method: "POST" }),
        );
      });
      await waitFor(() => {
        expect(
          screen.getAllByText(/nwi_revealedtoken456/).length,
        ).toBeGreaterThan(0);
      });
      expect(screen.getByText(/alerts\/ingest/)).toBeInTheDocument();
    });

    it("tests the webhook with the revealed credential and shows the resolved result", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { monitoring: "byo" });
      await user.click(
        await screen.findByRole("button", {
          name: /reveal ingest credential/i,
        }),
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
              Authorization: `Bearer ${REVEALED_INGEST}`,
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
            url === "/api/ingest-credential/reveal" &&
            init?.method === "POST"
          )
            return jsonOk({ token: REVEALED_INGEST });
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
        await screen.findByRole("button", {
          name: /reveal ingest credential/i,
        }),
      );
      await user.click(
        await screen.findByRole("button", { name: /test webhook/i }),
      );

      await waitFor(() => {
        expect(screen.getByText(/no runner advertises/i)).toBeInTheDocument();
      });
    });
  });

  describe("verify step", () => {
    it("closes via the Done button", async () => {
      const user = userEvent.setup();
      const { onClose } = setup({ runners: [CONNECTED_RUNNER] });
      await advanceToVerify(user);

      await user.click(screen.getByRole("button", { name: /done/i }));

      expect(onClose).toHaveBeenCalledTimes(1);
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
            body: JSON.stringify({ runnerId: "runner-web-01" }),
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

  describe("token hygiene on close", () => {
    it("deletes the minted token when the install command never rendered", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [AWAITING_RUNNER] });
      // connect.sh fails: the token is minted but no usable command is shown.
      fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/runners") return jsonOk([AWAITING_RUNNER]);
        if (url === "/api/tokens" && init?.method === "POST")
          return jsonOk(GENERATED_TOKEN, 201);
        if (url.startsWith("/api/tokens/") && init?.method === "DELETE")
          return jsonOk({}, 204);
        if (url === "/api/connect.sh")
          return Promise.resolve({ ok: false, status: 500 });
        return jsonOk({});
      });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(
          fetchMock.mock.calls.some((c) => c[0] === "/api/connect.sh"),
        ).toBe(true);
      });

      await user.keyboard("{Escape}");

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          `/api/tokens/${GENERATED_TOKEN.id}`,
          expect.objectContaining({ method: "DELETE" }),
        );
      });
    });

    it("keeps the token when the install command was shown", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup({ runners: [CONNECTED_RUNNER] });

      await startInstall(user, { name: "web-01" });
      await waitFor(() => {
        expect(screen.getByText(/install-docker/)).toBeInTheDocument();
      });

      await user.keyboard("{Escape}");

      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/tokens/"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
