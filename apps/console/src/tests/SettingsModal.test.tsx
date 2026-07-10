import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import type { AgentConfig } from "@nightwatch/shared";

import { AuthProvider } from "@/auth/AuthContext";
import { SettingsModal } from "@/components/layout/SettingsModal";
import { toast } from "@/lib/toast";

const OWNER_EMAIL = "admin@example.com";
const AUTH_STATUS_RESPONSE = {
  ownerExists: true,
  authenticated: true,
  email: OWNER_EMAIL,
};

const CONFIG: AgentConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  thinking: "adaptive",
  maxOutputTokens: 32000,
  maxRetries: 2,
  requestTimeoutMs: 120000,
  hardTimeoutMs: 300000,
  toolTimeoutMs: 15000,
  remediationBreakerLimit: 5,
  remediationBreakerWindowMs: 600000,
  codeSessionBudgetMs: 1200000,
  sandboxIdleTimeoutMs: 3600000,
  sandboxCpus: 2,
  sandboxMemoryMb: 4096,
  sandboxRequireGvisor: false,
  sandboxEgressPolicy: "allowlist",
  sandboxEgressAllowlist: ["registry.npmjs.org", "github.com"],
  baseUrl: undefined,
  apiKeyMasked: null,
  promptCaching: true,
  reasoningEffort: null,
};

const MODELS_RESPONSE = {
  models: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
};

function makeFetchMock(config: AgentConfig) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("/auth/status")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(AUTH_STATUS_RESPONSE),
      });
    }
    if (url.includes("/config/models")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(MODELS_RESPONSE),
      });
    }
    if (url.includes("/config/test")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
    }
    if (url.includes("/config/sandbox/egress-denials")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ hosts: ["cdn.playwright.dev"] }),
      });
    }
    if (url.includes("/config")) {
      if (init?.method === "PATCH") {
        const patched = { ...config, ...JSON.parse(init.body as string) };
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(patched),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(config),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

function renderModal(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const onClose = vi.fn();

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <SettingsModal opened onClose={onClose} />
        </AuthProvider>
      </QueryClientProvider>
    </TestProviders>,
  );

  return { fetchMock, onClose };
}

function setup(configOverride?: Partial<typeof CONFIG>) {
  const config = { ...CONFIG, ...configOverride };
  return renderModal(makeFetchMock(config));
}

async function openSection(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<void> {
  const tablist = screen.getByRole("tablist", { name: /settings sections/i });
  await user.click(within(tablist).getByRole("tab", { name }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toast.clean();
});

describe("SettingsModal", () => {
  describe("form state", () => {
    it("PATCHes /config with only the changed field when Save is clicked", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();

      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.clear(modelInput);
      await user.type(modelInput, "claude-opus-4-8");
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        const patchCall = fetchMock.mock.calls.find(
          ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
        );
        expect(patchCall).toBeDefined();
        expect(patchCall?.[0]).toContain("/config");
      });
    });

    it("shows an error notification when the save fails", async () => {
      const user = userEvent.setup();
      const fetchMock = vi
        .fn()
        .mockImplementation((url: string, init?: RequestInit) => {
          if (url.includes("/auth/status")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(AUTH_STATUS_RESPONSE),
            });
          }
          if (url.includes("/config/models")) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(MODELS_RESPONSE),
            });
          }
          if (url.includes("/config") && init?.method === "PATCH") {
            return Promise.resolve({ ok: false, status: 500 });
          }
          if (url.includes("/config")) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(CONFIG),
            });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        });
      renderModal(fetchMock);

      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.type(modelInput, "-edited");
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText(/save failed/i)).toBeInTheDocument();
      });
    });
  });

  describe("dirty-close guard", () => {
    it("asks before discarding unsaved changes and stays open on decline", async () => {
      const user = userEvent.setup();
      const { onClose } = setup();

      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.type(modelInput, "-edited");
      await user.click(screen.getByRole("button", { name: /close settings/i }));

      const dialog = await screen.findByRole("alertdialog");
      expect(
        within(dialog).getByText(/discard unsaved changes/i),
      ).toBeInTheDocument();
      await user.click(
        within(dialog).getByRole("button", { name: /^cancel$/i }),
      );

      expect(onClose).not.toHaveBeenCalled();
    });

    it("discards edits and closes when the prompt is accepted", async () => {
      const user = userEvent.setup();
      const { onClose } = setup();

      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.type(modelInput, "-edited");
      await user.click(screen.getByRole("button", { name: /close settings/i }));

      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: /^discard$/i }),
      );

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("API key", () => {
    it("lives in the Provider section, and Test Connection sends the entered key plus current provider/baseUrl/model", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /provider/i);

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-ant-newkey");

      await user.click(
        screen.getByRole("button", { name: /test connection/i }),
      );

      await waitFor(() => {
        const testCall = fetchMock.mock.calls.find(([url]) =>
          (url as string).includes("/config/test"),
        );
        expect(testCall).toBeDefined();
        const body = JSON.parse(
          (testCall?.[1] as RequestInit).body as string,
        ) as {
          apiKey: string;
          provider: string;
          model: string;
        };
        expect(body.apiKey).toBe("sk-ant-newkey");
        expect(body.provider).toBe(CONFIG.provider);
        expect(body.model).toBe(CONFIG.model);
      });
    });

    it("shows an error badge when Test Connection returns bad_key, and never PATCHes /config/key", async () => {
      const user = userEvent.setup();
      const fetchMock = vi
        .fn()
        .mockImplementation((url: string, init?: RequestInit) => {
          if ((url as string).includes("/auth/status")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(AUTH_STATUS_RESPONSE),
            });
          }
          if ((url as string).includes("/config/test")) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ ok: false, error: "bad_key" }),
            });
          }
          if ((url as string).includes("/config/models")) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(MODELS_RESPONSE),
            });
          }
          if ((url as string).includes("/config")) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(CONFIG),
            });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        });
      renderModal(fetchMock);
      await openSection(user, /provider/i);

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-bad");
      await user.click(
        screen.getByRole("button", { name: /test connection/i }),
      );

      await waitFor(() => {
        expect(screen.getByText(/invalid api key/i)).toBeInTheDocument();
      });
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            (url as string).includes("/config/key") &&
            (init as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(false);
    });

    it("disables Save for an untested key, and enables it once Test Connection succeeds", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-ant-newkey");

      expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();

      await user.click(
        screen.getByRole("button", { name: /test connection/i }),
      );

      await waitFor(() => {
        expect(screen.getByText(/connected/i)).toBeInTheDocument();
      });
      expect(
        screen.getByRole("button", { name: /^save$/i }),
      ).not.toBeDisabled();
    });

    it("PATCHes /config/key on Save after a successful test", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /provider/i);

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-ant-newkey");
      await user.click(
        screen.getByRole("button", { name: /test connection/i }),
      );
      await waitFor(() => {
        expect(screen.getByText(/connected/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => {
        const keyCall = fetchMock.mock.calls.find(
          ([url, init]) =>
            (url as string).includes("/config/key") &&
            (init as RequestInit | undefined)?.method === "PATCH",
        );
        expect(keyCall).toBeDefined();
        const body = JSON.parse(
          (keyCall?.[1] as RequestInit).body as string,
        ) as { apiKey: string };
        expect(body.apiKey).toBe("sk-ant-newkey");
      });
    });
  });

  describe("Account", () => {
    it("Log out all devices posts /api/logout-all", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /account/i);

      await user.click(
        await screen.findByRole("button", { name: /log out all devices/i }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/logout-all",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });
  });

  describe("Ingest credential", () => {
    const INGEST_TOKEN = "nwi_aBcDeFgHiJkLmNoPqRsTuVwXyZ12345";

    function setupIngest(configured: boolean) {
      const fetchMock = vi
        .fn()
        .mockImplementation((url: string, init?: RequestInit) => {
          if (url.includes("/auth/status")) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(AUTH_STATUS_RESPONSE),
            });
          }
          if (url.includes("/config/models")) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(MODELS_RESPONSE),
            });
          }
          if (url.includes("/ingest-credential") && init?.method === "POST") {
            return Promise.resolve({
              ok: true,
              status: 201,
              json: () => Promise.resolve({ token: INGEST_TOKEN }),
            });
          }
          if (url.includes("/ingest-credential")) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ configured }),
            });
          }
          if (url.includes("/config")) {
            return Promise.resolve({
              ok: true,
              // apiKeyMasked is set here to avoid colliding with this
              // section's own "Not configured" text for the ingest credential.
              json: () =>
                Promise.resolve({ ...CONFIG, apiKeyMasked: "sk-...test" }),
            });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        });

      const clipboardWrite = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: clipboardWrite },
        configurable: true,
      });

      const result = renderModal(fetchMock);
      return { ...result, clipboardWrite };
    }

    it("fetches GET /api/ingest-credential when the section opens", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setupIngest(false);
      await openSection(user, /alerting/i);
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/ingest-credential");
      });
    });

    it("POSTs /api/ingest-credential and shows the plaintext once on Generate", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setupIngest(false);
      await openSection(user, /alerting/i);

      await user.click(
        await screen.findByRole("button", { name: /generate credential/i }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/ingest-credential",
          expect.objectContaining({ method: "POST" }),
        );
        expect(screen.getByText(INGEST_TOKEN)).toBeInTheDocument();
      });
      expect(screen.getByText(/no longer works/i)).toBeInTheDocument();
    });

    it("reveals the credential on demand via POST /reveal when configured", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setupIngest(true);
      await openSection(user, /alerting/i);

      await user.click(
        await screen.findByRole("button", { name: /reveal credential/i }),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/ingest-credential/reveal",
          expect.objectContaining({ method: "POST" }),
        );
        expect(screen.getByText(INGEST_TOKEN)).toBeInTheDocument();
      });
      // A revealed (not freshly minted) token does not claim the old one is dead.
      expect(screen.queryByText(/no longer works/i)).not.toBeInTheDocument();
    });

    it("copies the credential to clipboard when copy button is clicked", async () => {
      const user = userEvent.setup();
      const { clipboardWrite } = setupIngest(false);
      await openSection(user, /alerting/i);

      await user.click(
        await screen.findByRole("button", { name: /generate credential/i }),
      );
      await waitFor(() => {
        expect(screen.getByText(INGEST_TOKEN)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /copy/i }));
      expect(clipboardWrite).toHaveBeenCalledWith(INGEST_TOKEN);
    });
  });

  describe("sandbox egress", () => {
    it("shows the allowlist editor only under the allowlist policy", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /sandbox/i);

      expect(
        await screen.findByLabelText(/allowed hosts/i),
      ).toBeInTheDocument();

      await user.selectOptions(
        screen.getByLabelText(/network egress/i),
        "open",
      );
      expect(screen.queryByLabelText(/allowed hosts/i)).not.toBeInTheDocument();
    });

    it("offers a recently-blocked host as a one-click add to the allowlist", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /sandbox/i);

      const chip = await screen.findByRole("button", {
        name: /cdn\.playwright\.dev/i,
      });
      await user.click(chip);

      const textarea = screen.getByLabelText(/allowed hosts/i);
      expect(textarea).toHaveValue(
        "registry.npmjs.org\ngithub.com\ncdn.playwright.dev",
      );

      await user.click(screen.getByRole("button", { name: /^save$/i }));
      await waitFor(() => {
        const patch = fetchMock.mock.calls.find(
          (call) =>
            call[0] === "/api/config" &&
            (call[1] as RequestInit | undefined)?.method === "PATCH",
        );
        expect(patch).toBeDefined();
        const body = JSON.parse(String((patch![1] as RequestInit).body)) as {
          sandboxEgressAllowlist?: string[];
        };
        expect(body.sandboxEgressAllowlist).toEqual([
          "registry.npmjs.org",
          "github.com",
          "cdn.playwright.dev",
        ]);
      });
    });
  });
});
