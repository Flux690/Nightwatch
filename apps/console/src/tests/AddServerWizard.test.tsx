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
      if (url === "/api/runners") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(runners),
        });
      }
      if (url === "/api/tokens" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve(GENERATED_TOKEN),
        });
      }
      if (url === "/api/connect.sh") {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(CONNECT_SCRIPT),
        });
      }
      if (url === "/api/manifest.yaml") {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(MANIFEST_YAML),
        });
      }
      if (url === "/api/ingest-credential" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({ token: "nwi_generatedtoken123" }),
        });
      }
      if (url === "/api/ingest-credential") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ configured: false }),
        });
      }
      if (url === "/api/alerts/test" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              status: "enqueued",
              runnerId: "runner-web-01",
              hostname: "web-01",
            }),
        });
      }
      if (url === "/api/alerts/validate" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              alerts: [
                {
                  sourceAlertId: "sample",
                  identity: {
                    provider: "docker",
                    project: "sample-service",
                    service: "sample-service",
                  },
                  identityKey: "docker/sample-service/sample-service",
                  alertType: "TestAlert",
                  severity: "warning",
                  resolution: {
                    status: "resolved",
                    runnerId: "runner-web-01",
                    hostname: "web-01",
                  },
                },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
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

  it("shows provider selection as the first step", () => {
    setup();
    expect(screen.getByRole("radio", { name: /docker/i })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /kubernetes/i }),
    ).toBeInTheDocument();
  });

  it("disables Continue until a provider is chosen", () => {
    setup();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("requires a server name — Continue stays disabled until both provider and name are filled", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("radio", { name: /docker/i }));
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();

    await user.type(
      screen.getByRole("textbox", { name: /server name/i }),
      "web-01",
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

  it("mints a runner token and shows the docker run script after choosing Docker", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup();

    await user.click(screen.getByRole("radio", { name: /docker/i }));
    await user.type(
      screen.getByRole("textbox", { name: /server name/i }),
      "web-01",
    );
    await user.click(screen.getByRole("button", { name: /continue/i }));

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

    await user.click(screen.getByRole("radio", { name: /docker/i }));
    await user.type(
      screen.getByRole("textbox", { name: /server name/i }),
      "prod-web-01",
    );
    await user.click(screen.getByRole("button", { name: /continue/i }));

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

  it("mints a runner token and shows the Kubernetes manifest after choosing Kubernetes", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("radio", { name: /kubernetes/i }));
    await user.type(
      screen.getByRole("textbox", { name: /server name/i }),
      "k8s-cluster",
    );
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText(/nightwatch-runner/)).toBeInTheDocument();
    });
  });

  it("shows an awaiting-connection state while the runner has not connected", async () => {
    const user = userEvent.setup();
    setup({ runners: [AWAITING_RUNNER] });

    await user.click(screen.getByRole("radio", { name: /docker/i }));
    await user.type(
      screen.getByRole("textbox", { name: /server name/i }),
      "web-01",
    );
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText(/waiting for/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
  });

  it("enables Continue once the runner connects", async () => {
    const user = userEvent.setup();
    setup({ runners: [CONNECTED_RUNNER] });

    await user.click(screen.getByRole("radio", { name: /docker/i }));
    await user.type(
      screen.getByRole("textbox", { name: /server name/i }),
      "web-01",
    );
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText(/connected/i)).toBeInTheDocument();
    });
    const continueButtons = screen.getAllByRole("button", {
      name: /continue/i,
    });
    expect(continueButtons[continueButtons.length - 1]).toBeEnabled();
  });

  async function advanceToMonitoringStep(
    user: ReturnType<typeof userEvent.setup>,
    serverName = "test-server",
  ): Promise<void> {
    await user.click(screen.getByRole("radio", { name: /docker/i }));
    await user.type(
      screen.getByRole("textbox", { name: /server name/i }),
      serverName,
    );
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => {
      expect(screen.getByText(/connected/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /continue/i }));
  }

  it("monitoring step shows a BYO relabel snippet with the chosen server name", async () => {
    const user = userEvent.setup();
    setup({ runners: [CONNECTED_RUNNER] });
    await advanceToMonitoringStep(user, "prod-web-01");

    expect(screen.getByText(/instance/i)).toBeInTheDocument();
    expect(screen.getByText(/prod-web-01/)).toBeInTheDocument();
  });

  it("shows a Generate credential button when no ingest credential exists yet", async () => {
    const user = userEvent.setup();
    setup({ runners: [CONNECTED_RUNNER] });
    await advanceToMonitoringStep(user);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /generate credential/i }),
      ).toBeInTheDocument();
    });
  });

  it("does not offer a Rotate credential button in the monitoring step when a credential is already configured", async () => {
    const user = userEvent.setup();
    setup({ runners: [CONNECTED_RUNNER] });

    // Override ingest-credential to return configured:true for this test.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/runners") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([CONNECTED_RUNNER]),
          });
        }
        if (url === "/api/tokens" && init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve(GENERATED_TOKEN),
          });
        }
        if (url === "/api/connect.sh") {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(CONNECT_SCRIPT),
          });
        }
        if (url === "/api/ingest-credential") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ configured: true }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    await advanceToMonitoringStep(user);

    await waitFor(() => {
      expect(screen.getByText(/^configured$/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /rotate credential/i }),
    ).not.toBeInTheDocument();
  });

  it("reveals an existing credential on demand via POST /reveal", async () => {
    const user = userEvent.setup();
    setup({ runners: [CONNECTED_RUNNER] });

    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/runners") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([CONNECTED_RUNNER]),
          });
        }
        if (url === "/api/tokens" && init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve(GENERATED_TOKEN),
          });
        }
        if (url === "/api/connect.sh") {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(CONNECT_SCRIPT),
          });
        }
        if (
          url === "/api/ingest-credential/reveal" &&
          init?.method === "POST"
        ) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ token: "nwi_revealedtoken456" }),
          });
        }
        if (url === "/api/ingest-credential") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ configured: true }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
    vi.stubGlobal("fetch", fetchMock);

    await advanceToMonitoringStep(user);

    await user.click(
      await screen.findByRole("button", { name: /reveal credential/i }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ingest-credential/reveal",
        expect.objectContaining({ method: "POST" }),
      );
      expect(
        screen.getAllByText(/nwi_revealedtoken456/).length,
      ).toBeGreaterThan(0);
    });
  });

  it("generates the ingest credential and shows it once with the webhook config", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ runners: [CONNECTED_RUNNER] });
    await advanceToMonitoringStep(user);

    await user.click(
      await screen.findByRole("button", { name: /generate credential/i }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/ingest-credential",
        expect.objectContaining({ method: "POST" }),
      );
    });
    await waitFor(() => {
      expect(
        screen.getAllByText(/nwi_generatedtoken123/).length,
      ).toBeGreaterThan(0);
    });
    expect(screen.getByText(/alerts\/ingest/)).toBeInTheDocument();
  });

  it("tests the webhook with the ingest credential and shows the resolved result", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ runners: [CONNECTED_RUNNER] });
    await advanceToMonitoringStep(user);

    await user.click(
      await screen.findByRole("button", { name: /generate credential/i }),
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
            Authorization: "Bearer nwi_generatedtoken123",
          }),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText(/resolved/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/web-01/)).toBeInTheDocument();
  });

  it("shows the rejection reason when the test webhook payload doesn't match the fleet", async () => {
    const user = userEvent.setup();
    setup({ runners: [CONNECTED_RUNNER] });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/runners") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([CONNECTED_RUNNER]),
          });
        }
        if (url === "/api/tokens" && init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve(GENERATED_TOKEN),
          });
        }
        if (url === "/api/connect.sh") {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(CONNECT_SCRIPT),
          });
        }
        if (url === "/api/ingest-credential" && init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve({ token: "nwi_generatedtoken123" }),
          });
        }
        if (url === "/api/ingest-credential") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ configured: false }),
          });
        }
        if (url === "/api/alerts/validate") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                alerts: [
                  {
                    sourceAlertId: "sample",
                    identity: {
                      provider: "docker",
                      project: "sample-service",
                      service: "sample-service",
                    },
                    identityKey: "docker/sample-service/sample-service",
                    alertType: "TestAlert",
                    severity: "warning",
                    resolution: {
                      status: "rejected",
                      reason:
                        "No runner advertises service 'docker/sample-service/sample-service'.",
                    },
                  },
                ],
              }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    await advanceToMonitoringStep(user);
    await user.click(
      await screen.findByRole("button", { name: /generate credential/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /test webhook/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/no runner advertises/i)).toBeInTheDocument();
    });
  });

  async function advanceToVerifyStep(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await advanceToMonitoringStep(user);
    await user.click(await screen.findByRole("button", { name: /continue/i }));
  }

  it("closes via the Verify step's Done button", async () => {
    const user = userEvent.setup();
    const { onClose } = setup({ runners: [CONNECTED_RUNNER] });
    await advanceToVerifyStep(user);

    await user.click(screen.getByRole("button", { name: /done/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sends a test alert and reports success once the pipeline confirms", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup({ runners: [CONNECTED_RUNNER] });
    await advanceToVerifyStep(user);

    await user.click(screen.getByRole("button", { name: /send test alert/i }));

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
    expect(screen.getByText(/web-01/)).toBeInTheDocument();
  });

  it("shows an error when the test alert fails", async () => {
    const user = userEvent.setup();
    setup({ runners: [CONNECTED_RUNNER] });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/runners") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([CONNECTED_RUNNER]),
          });
        }
        if (url === "/api/tokens" && init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: () => Promise.resolve(GENERATED_TOKEN),
          });
        }
        if (url === "/api/connect.sh") {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(CONNECT_SCRIPT),
          });
        }
        if (url === "/api/ingest-credential") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ configured: false }),
          });
        }
        if (url === "/api/alerts/test") {
          return Promise.resolve({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ error: "runner not connected" }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    await advanceToVerifyStep(user);
    await user.click(screen.getByRole("button", { name: /send test alert/i }));

    await waitFor(() => {
      expect(screen.getByText(/runner not connected/i)).toBeInTheDocument();
    });
  });
});
