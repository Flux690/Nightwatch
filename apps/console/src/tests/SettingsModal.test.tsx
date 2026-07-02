import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import type { AgentConfig } from "@nightwatch/shared";

import { AuthProvider } from "../auth/AuthContext.js";
import { SettingsModal } from "../pages/SettingsModal.js";
import { toast } from "../ui/Toast.js";

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
  const rail = screen.getByRole("navigation", { name: /settings sections/i });
  await user.click(within(rail).getByRole("button", { name }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toast.clean();
});

describe("SettingsModal", () => {
  describe("rail navigation", () => {
    it("shows the Model section by default and switches panes via the rail", async () => {
      const user = userEvent.setup();
      setup();

      expect(
        await screen.findByLabelText(/max output tokens/i),
      ).toBeInTheDocument();

      await openSection(user, /loop/i);
      expect(await screen.findByLabelText(/max retries/i)).toBeInTheDocument();
      expect(
        screen.queryByLabelText(/max output tokens/i),
      ).not.toBeInTheDocument();
    });
  });

  describe("form state", () => {
    it("populates Model and Loop fields from GET /config on mount", async () => {
      const user = userEvent.setup();
      setup();
      await waitFor(() => {
        expect(screen.getByLabelText(/max output tokens/i)).toHaveValue(
          "32000",
        );
      });
      await openSection(user, /loop/i);
      expect(screen.getByLabelText(/max retries/i)).toHaveValue("2");
    });

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

    it("disables Save when the form matches the persisted config", async () => {
      setup();
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
      });
    });

    it("enables Save the moment a field is edited", async () => {
      const user = userEvent.setup();
      setup();

      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
      });

      await user.type(modelInput, "-edited");

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
      });
    });

    it("shows a spinner on Save while the PATCH request is in flight", async () => {
      const user = userEvent.setup();
      let resolvePatch: ((value: AgentConfig) => void) | undefined;
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
            return new Promise((resolve) => {
              resolvePatch = (value: AgentConfig) =>
                resolve({ ok: true, json: () => Promise.resolve(value) });
            });
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
      const saveButton = screen.getByRole("button", { name: /save/i });
      await user.click(saveButton);

      await waitFor(() => {
        expect(saveButton).toHaveAttribute("data-loading", "true");
      });

      resolvePatch?.(CONFIG);

      await waitFor(() => {
        expect(saveButton).not.toHaveAttribute("data-loading", "true");
      });
    });

    it("shows a success notification after a successful save", async () => {
      const user = userEvent.setup();
      setup();

      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.type(modelInput, "-edited");
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText(/settings saved/i)).toBeInTheDocument();
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

    it("populates the model combobox from GET /config/models on mount", async () => {
      setup();
      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      expect(modelInput).toHaveValue("claude-sonnet-4-6");
    });
  });

  describe("dirty-close guard", () => {
    it("closes without a prompt when nothing changed", async () => {
      const user = userEvent.setup();
      const confirmSpy = vi.spyOn(window, "confirm");
      const { onClose } = setup();

      await screen.findByLabelText(/max output tokens/i);
      await user.click(screen.getByRole("button", { name: /close settings/i }));

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("asks before discarding unsaved changes and stays open on decline", async () => {
      const user = userEvent.setup();
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      const { onClose } = setup();

      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.type(modelInput, "-edited");
      await user.click(screen.getByRole("button", { name: /close settings/i }));

      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("discards edits and closes when the prompt is accepted", async () => {
      const user = userEvent.setup();
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const { onClose } = setup();

      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.type(modelInput, "-edited");
      await user.click(screen.getByRole("button", { name: /close settings/i }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("API key", () => {
    it("shows 'Not configured' when apiKeyMasked is null", async () => {
      const user = userEvent.setup();
      setup({ apiKeyMasked: null });
      await openSection(user, /api key/i);
      await waitFor(() => {
        const form = document.querySelector("form");
        expect(within(form!).getByText(/not configured/i)).toBeInTheDocument();
      });
    });

    it("shows the masked key when apiKeyMasked is set", async () => {
      const user = userEvent.setup();
      setup({ apiKeyMasked: "sk-...abcd" });
      await openSection(user, /api key/i);
      await waitFor(() => {
        expect(screen.getByText("sk-...abcd")).toBeInTheDocument();
      });
    });

    it("renders the API key input as write-only (no readValue displayed)", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /api key/i);
      const keyInput = screen.getByPlaceholderText(/paste api key/i);
      expect(keyInput).toHaveValue("");
    });

    it("POSTs /config/test with the entered key on Test Connection click", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /api key/i);

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
        };
        expect(body.apiKey).toBe("sk-ant-newkey");
      });
    });

    it("shows success badge after a successful Test Connection", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /api key/i);

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-ant-good-key");
      await user.click(
        screen.getByRole("button", { name: /test connection/i }),
      );

      await waitFor(() => {
        expect(screen.getByText(/connected/i)).toBeInTheDocument();
      });
    });

    it("shows an error badge when Test Connection returns bad_key", async () => {
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
      await openSection(user, /api key/i);

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-bad");
      await user.click(
        screen.getByRole("button", { name: /test connection/i }),
      );

      await waitFor(() => {
        expect(screen.getByText(/invalid api key/i)).toBeInTheDocument();
      });
    });
  });

  describe("conditional provider knobs", () => {
    it("shows Thinking mode selector only when provider is Anthropic", async () => {
      setup({ provider: "anthropic" });
      await waitFor(() => {
        expect(
          screen.getByLabelText(/thinking/i, { selector: "input" }),
        ).toBeInTheDocument();
      });
    });

    it("hides Thinking mode selector when provider is OpenAI", async () => {
      setup({ provider: "openai" });
      await waitFor(() => {
        expect(screen.getByLabelText(/max output tokens/i)).toBeInTheDocument();
      });
      expect(screen.queryByLabelText(/^thinking/i)).not.toBeInTheDocument();
    });

    it("shows Reasoning effort selector only when provider is OpenAI", async () => {
      setup({ provider: "openai" });
      await waitFor(() => {
        expect(
          screen.getByLabelText(/reasoning effort/i, { selector: "input" }),
        ).toBeInTheDocument();
      });
    });

    it("hides Reasoning effort selector when provider is Anthropic", async () => {
      setup({ provider: "anthropic" });
      await waitFor(() => {
        expect(screen.getByLabelText(/max output tokens/i)).toBeInTheDocument();
      });
      expect(
        screen.queryByLabelText(/reasoning effort/i, { selector: "input" }),
      ).not.toBeInTheDocument();
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

    it("shows 'Not configured' and a Generate button when no credential exists", async () => {
      const user = userEvent.setup();
      setupIngest(false);
      await openSection(user, /alerting/i);
      await waitFor(() => {
        expect(screen.getByText(/not configured/i)).toBeInTheDocument();
      });
      expect(
        screen.getByRole("button", { name: /generate credential/i }),
      ).toBeInTheDocument();
    });

    it("shows 'Configured' and a Rotate button when a credential exists", async () => {
      const user = userEvent.setup();
      setupIngest(true);
      await openSection(user, /alerting/i);
      await waitFor(() => {
        expect(screen.getByText(/^configured$/i)).toBeInTheDocument();
      });
      expect(
        screen.getByRole("button", { name: /rotate credential/i }),
      ).toBeInTheDocument();
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
});
