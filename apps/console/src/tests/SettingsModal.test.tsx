import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import type { AgentConfig } from "@nightwarden/shared";

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
  providers: {
    anthropic: {
      model: "claude-sonnet-4-6",
      baseUrl: undefined,
      apiKeyMasked: null,
      thinking: "adaptive",
    },
    openai: {
      model: null,
      baseUrl: undefined,
      apiKeyMasked: null,
      reasoningEffort: null,
    },
  },
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
  sandboxNetwork: "none",
  sandboxAllowlistHosts: ["registry.npmjs.org"],
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
        expect(body.model).toBe(CONFIG.providers.anthropic.model);
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

  describe("sandbox network", () => {
    it("saves the agent network knob and explains what each mode means", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /sandbox/i);

      const select = await screen.findByLabelText(/agent network/i);
      expect(select).toHaveValue("none");
      expect(screen.getByText(/no network at all/i)).toBeInTheDocument();

      await user.selectOptions(select, "open");
      expect(
        screen.getByText(/could exfiltrate repository content/i),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /^save$/i }));
      await waitFor(() => {
        const patch = fetchMock.mock.calls.find(
          (call) =>
            call[0] === "/api/config" &&
            (call[1] as RequestInit | undefined)?.method === "PATCH",
        );
        expect(patch).toBeDefined();
        const body = JSON.parse(String((patch![1] as RequestInit).body)) as {
          sandboxNetwork?: string;
        };
        expect(body.sandboxNetwork).toBe("open");
      });
    });

    it("allowlist mode shows the editable hosts textarea and saves trimmed lines", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /sandbox/i);

      const select = await screen.findByLabelText(/agent network/i);
      await user.selectOptions(select, "allowlist");
      expect(
        screen.getByText(/enforcing proxy that reaches only the hosts below/i),
      ).toBeInTheDocument();

      const textarea = screen.getByLabelText(/allowed hosts/i);
      await user.clear(textarea);
      await user.type(textarea, "registry.npmjs.org{enter}internal.dev{enter}");

      await user.click(screen.getByRole("button", { name: /^save$/i }));
      await waitFor(() => {
        const patch = fetchMock.mock.calls.find(
          (call) =>
            call[0] === "/api/config" &&
            (call[1] as RequestInit | undefined)?.method === "PATCH",
        );
        expect(patch).toBeDefined();
        const body = JSON.parse(String((patch![1] as RequestInit).body)) as {
          sandboxNetwork?: string;
          sandboxAllowlistHosts?: string[];
        };
        expect(body.sandboxNetwork).toBe("allowlist");
        // The trailing blank line from typing is dropped on save.
        expect(body.sandboxAllowlistHosts).toEqual([
          "registry.npmjs.org",
          "internal.dev",
        ]);
      });
    });
  });
});
