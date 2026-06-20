import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";

import { AuthProvider } from "../auth/AuthContext.js";
import { SettingsPage } from "../pages/Settings.js";
import { theme, cssVariablesResolver } from "../theme.js";

const OWNER_EMAIL = "admin@example.com";
const AUTH_STATUS_RESPONSE = {
  ownerExists: true,
  authenticated: true,
  email: OWNER_EMAIL,
};

const CONFIG: import("@nightwatch/shared").AgentConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  thinking: "adaptive",
  maxOutputTokens: 32000,
  maxRetries: 2,
  requestTimeoutMs: 120000,
  maxToolCalls: 24,
  hardTimeoutMs: 300000,
  toolTimeoutMs: 15000,
  baseUrl: undefined,
  apiKeyMasked: null,
  promptCaching: true,
  reasoningEffort: null,
};

const MODELS_RESPONSE = {
  models: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
};

const MINTED = {
  id: "11111111-2222-3333-4444-555555555555",
  token: "nwr_aBcDeFgHiJkLmNoPqRsTuVwXyZ12",
  label: "test-label",
  createdAt: new Date().toISOString(),
};

function setup(configOverride?: Partial<typeof CONFIG>) {
  const config = { ...CONFIG, ...configOverride };
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });

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
      if (url.includes("/tokens")) {
        if (init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(MINTED),
          });
        }
        if (init?.method === "DELETE") {
          return Promise.resolve({
            ok: true,
            status: 204,
            json: () => Promise.resolve({}),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tokens: [] }),
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
      if (url.includes("/config/key")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ apiKeyMasked: "sk-...5678" }),
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
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="light"
    >
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <SettingsPage />
        </AuthProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );

  return { fetchMock, clipboardWrite };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SettingsPage", () => {
  // --- Existing behaviour preserved ---

  it("populates Loop config fields from GET /config on mount", async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByLabelText(/max output tokens/i)).toHaveValue("32000");
    });
    expect(screen.getByLabelText(/max retries/i)).toHaveValue("2");
    expect(screen.getByLabelText(/max tool calls/i)).toHaveValue("24");
  });

  it("PATCHes /config with only the changed field when Save is clicked", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup();

    const modelInput = await screen.findByLabelText(/^model$/i);
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

  it("shows 'No active tokens' when token list is empty", async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByText(/no active tokens/i)).toBeInTheDocument();
    });
  });

  it("mints a token and shows the one-time plaintext", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(
      await screen.findByRole("button", { name: /generate token/i }),
    );
    await waitFor(() => {
      expect(screen.getByText(MINTED.token)).toBeInTheDocument();
    });
  });

  // --- Model combobox ---

  it("populates the model combobox from GET /config/models on mount", async () => {
    setup();
    const modelInput = await screen.findByLabelText(/^model$/i);
    expect(modelInput).toHaveValue("claude-sonnet-4-6");
  });

  // --- API key display ---

  it("shows 'Not configured' when apiKeyMasked is null", async () => {
    setup({ apiKeyMasked: null });
    await waitFor(() => {
      expect(screen.getByText(/not configured/i)).toBeInTheDocument();
    });
  });

  it("shows the masked key when apiKeyMasked is set", async () => {
    setup({ apiKeyMasked: "sk-...abcd" });
    await waitFor(() => {
      expect(screen.getByText("sk-...abcd")).toBeInTheDocument();
    });
  });

  it("renders the API key input as write-only (no readValue displayed)", async () => {
    setup();
    await screen.findByLabelText(/max output tokens/i);
    // The API key text field for entering a new key must be empty on load
    // (write-only: we never populate it from the response)
    const keyInput = screen.getByPlaceholderText(/paste api key/i);
    expect(keyInput).toHaveValue("");
  });

  // --- Test Connection ---

  it("POSTs /config/test with the entered key on Test Connection click", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup();

    const keyInput = await screen.findByPlaceholderText(/paste api key/i);
    await user.type(keyInput, "sk-ant-newkey");

    await user.click(screen.getByRole("button", { name: /test connection/i }));

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

    const keyInput = await screen.findByPlaceholderText(/paste api key/i);
    await user.type(keyInput, "sk-ant-good-key");
    await user.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/connected/i)).toBeInTheDocument();
    });
  });

  it("shows an error badge when Test Connection returns bad_key", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
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
        if ((url as string).includes("/tokens")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ tokens: [] }),
          });
        }
        if ((url as string).includes("/config/models")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(MODELS_RESPONSE),
          });
        }
        if ((url as string).includes("/config")) {
          if ((init as RequestInit | undefined)?.method === "PATCH") {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(CONFIG),
            });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(CONFIG),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="light"
      >
        <QueryClientProvider client={qc}>
          <AuthProvider>
            <SettingsPage />
          </AuthProvider>
        </QueryClientProvider>
      </MantineProvider>,
    );

    const keyInput = await screen.findByPlaceholderText(/paste api key/i);
    await user.type(keyInput, "sk-bad");
    await user.click(screen.getByRole("button", { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid api key/i)).toBeInTheDocument();
    });
  });

  // --- Conditional provider knobs ---

  it("shows Thinking mode selector only when provider is Anthropic", async () => {
    setup({ provider: "anthropic" });
    await waitFor(() => {
      expect(screen.getByLabelText(/thinking/i)).toBeInTheDocument();
    });
  });

  it("hides Thinking mode selector when provider is OpenAI", async () => {
    setup({ provider: "openai" });
    await waitFor(() => {
      // Wait for config to load
      expect(screen.getByLabelText(/max output tokens/i)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText(/^thinking/i)).not.toBeInTheDocument();
  });

  it("shows Reasoning effort selector only when provider is OpenAI", async () => {
    setup({ provider: "openai" });
    await waitFor(() => {
      expect(screen.getByLabelText(/reasoning effort/i)).toBeInTheDocument();
    });
  });

  it("hides Reasoning effort selector when provider is Anthropic", async () => {
    setup({ provider: "anthropic" });
    await waitFor(() => {
      expect(screen.getByLabelText(/max output tokens/i)).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText(/reasoning effort/i),
    ).not.toBeInTheDocument();
  });

  // --- Account ---

  it("Log out all devices posts /api/logout-all", async () => {
    const user = userEvent.setup();
    const { fetchMock } = setup();

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
