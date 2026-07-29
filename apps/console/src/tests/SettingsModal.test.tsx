import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import type {
  AgentConfig,
  ModelCatalog,
  ModelOption,
  ProviderOption,
  ReasoningDescriptor,
} from "@nightwarden/shared";

import { AuthProvider } from "@/auth/AuthContext";
import { SettingsModal } from "@/components/layout/SettingsModal";
import { toast } from "@/lib/toast";

const OWNER_EMAIL = "admin@example.com";
const AUTH_STATUS_RESPONSE = {
  ownerExists: true,
  authenticated: true,
  email: OWNER_EMAIL,
};

// The chosen model's ladder is stored with the model, so the settings form has
// it the moment the config lands and never waits on a request to draw a control.
const EFFORT_LADDER: ReasoningDescriptor = {
  label: "Effort",
  levels: [
    { value: "max", label: "Max" },
    { value: "high", label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
  ],
  defaultLevel: "high",
  canDisable: true,
};

const CONFIG: AgentConfig = {
  provider: "anthropic",
  providers: {
    anthropic: {
      model: "claude-sonnet-4-6",
      baseUrl: undefined,
      apiKeyMasked: null,
      reasoningLevel: "high",
      maxOutputTokens: 64_000,
      reasoning: EFFORT_LADDER,
    },
    openrouter: {
      model: null,
      baseUrl: undefined,
      apiKeyMasked: null,
      reasoningLevel: null,
      maxOutputTokens: null,
      reasoning: null,
    },
  },
  maxRetries: 2,
  requestTimeoutMs: 120000,
  checkInAfterMs: 1800000,
  toolCallCeilingMs: 600000,
  remediationBreakerLimit: 5,
  remediationBreakerWindowMs: 600000,
  sandboxIdleTimeoutMs: 3600000,
  sandboxCpus: 2,
  sandboxMemoryMb: 4096,
  sandboxRequireGvisor: false,
  sandboxNetwork: "none",
  sandboxAllowlistHosts: ["registry.npmjs.org"],
};

// Effort levels vary per model, so the fixture carries a full descriptor on one
// and none on another: the form must render whatever the catalog says.
const MODELS_RESPONSE: ModelCatalog = {
  ok: true,
  models: [
    {
      id: "claude-sonnet-4-6",
      reasoning: {
        label: "Effort",
        levels: [
          { value: "max", label: "Max" },
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        defaultLevel: "high",
        canDisable: true,
      },
      maxOutputTokens: 64_000,
    },
    {
      id: "claude-opus-4-8",
      reasoning: null,
      maxOutputTokens: null,
    },
    {
      id: "claude-haiku-4-5-20251001",
      reasoning: null,
      maxOutputTokens: null,
    },
  ],
};

// The picker is served, not hardcoded, so a new adapter needs no console change.
const PROVIDERS_RESPONSE: { providers: ProviderOption[] } = {
  providers: [
    {
      name: "anthropic",
      label: "Anthropic",
      defaultBaseUrl: "https://api.anthropic.com",
    },
    {
      name: "openrouter",
      label: "OpenRouter",
      defaultBaseUrl: "https://openrouter.ai/api/v1",
    },
  ],
};

// A promise lets a test hold the catalog open and prove what renders without it.
function makeFetchMock(
  config: AgentConfig,
  models: ModelCatalog | Promise<ModelCatalog> = MODELS_RESPONSE,
) {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes("/auth/status")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(AUTH_STATUS_RESPONSE),
      });
    }
    if (url.includes("/config/providers")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(PROVIDERS_RESPONSE),
      });
    }
    if (url.includes("/config/models")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(models),
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

  return { fetchMock, onClose, qc };
}

function setup(
  configOverride?: Partial<typeof CONFIG>,
  modelsOverride?: ModelCatalog | Promise<ModelCatalog>,
) {
  const config = { ...CONFIG, ...configOverride };
  return renderModal(makeFetchMock(config, modelsOverride));
}

async function openSection(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<void> {
  const tablist = screen.getByRole("tablist", { name: /settings sections/i });
  await user.click(within(tablist).getByRole("tab", { name }));
}

// Everything the catalog has to say is said in the suggestion list, so a test
// about it opens the list first.
const openModelList = async (
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> => {
  await user.click(screen.getByLabelText(/^model$/i, { selector: "input" }));
};

// Typing in the model field opens its suggestion list over the rest of the
// form. A real user moves on to another field, which dismisses it and leaves
// the typed id in place.
const dismissModelList = (
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> => user.click(screen.getByLabelText(/^base url$/i));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toast.clean();
});

describe("SettingsModal", () => {
  describe("form state", () => {
    it("keeps unsaved edits when the config refetches underneath", async () => {
      const user = userEvent.setup();
      const { qc } = setup();

      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.clear(modelInput);
      await user.type(modelInput, "claude-opus-4-8");

      // Window focus alone triggers a refetch in a real browser, so an edit in
      // progress has to survive one.
      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["config"] });
      });

      expect(
        await screen.findByLabelText(/^model$/i, { selector: "input" }),
      ).toHaveValue("claude-opus-4-8");
    });

    it("PATCHes /config with only the changed field when Save is clicked", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();

      const modelInput = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.clear(modelInput);
      await user.type(modelInput, "claude-opus-4-8");
      await dismissModelList(user);
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
          if (url.includes("/config/providers")) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve(PROVIDERS_RESPONSE),
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
      await dismissModelList(user);
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
      await dismissModelList(user);
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
      await dismissModelList(user);
      await user.click(screen.getByRole("button", { name: /close settings/i }));

      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: /^discard$/i }),
      );

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("model field", () => {
    // The field is a search over the catalog, so typing has to narrow the list.
    // Driving the real component is the only way to see that it does.
    it("narrows the list to what was typed", async () => {
      const user = userEvent.setup();
      setup(undefined, {
        ok: true,
        models: [
          {
            id: "openai/gpt-oss-20b:free",
            reasoning: null,
            maxOutputTokens: null,
          },
          {
            id: "anthropic/claude-opus-5",
            reasoning: null,
            maxOutputTokens: null,
          },
          {
            id: "meta/llama-4:free",
            reasoning: null,
            maxOutputTokens: null,
          },
        ],
      });
      await openSection(user, /provider/i);

      const input = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.clear(input);
      await user.type(input, "free");

      const listed = await screen.findByRole("listbox");
      await waitFor(() => {
        expect(
          within(listed)
            .getAllByRole("option")
            .map((o) => o.textContent),
        ).toEqual(["openai/gpt-oss-20b:free", "meta/llama-4:free"]);
      });
    });

    it("keeps an id typed by hand, so an unlisted model can still be set", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /provider/i);

      const input = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.clear(input);
      await user.type(input, "some/unlisted-model");
      await dismissModelList(user);
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => {
        const patch = fetchMock.mock.calls.find(
          ([url, init]) =>
            (url as string).endsWith("/config") &&
            (init as RequestInit | undefined)?.method === "PATCH",
        );
        expect(patch).toBeDefined();
        const body = JSON.parse((patch?.[1] as RequestInit).body as string) as {
          providers: { anthropic: { model: string } };
        };
        expect(body.providers.anthropic.model).toBe("some/unlisted-model");
      });
    });

    it("says only that it is loading until the catalog has answered", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);
      await openModelList(user);

      // Before the answer lands there is one honest message, not a guess that
      // gets corrected a frame later.
      expect(screen.queryByText(/add an api key/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/listed no models/i)).not.toBeInTheDocument();

      await screen.findByRole("option", { name: /claude-sonnet-4-6/ });
      expect(screen.queryByText(/loading models/i)).not.toBeInTheDocument();
    });

    it("asks for a key when the provider will not list models without one", async () => {
      const user = userEvent.setup();
      setup(undefined, { ok: false, error: "needs_key" });
      await openSection(user, /provider/i);
      await openModelList(user);

      expect(await screen.findByText(/add an api key/i)).toBeInTheDocument();
    });
  });

  describe("reasoning control", () => {
    // Renders one provider's block with the ladder it stores for its model.
    function withLadder(reasoning: ReasoningDescriptor | null) {
      return {
        providers: {
          ...CONFIG.providers,
          anthropic: { ...CONFIG.providers.anthropic, reasoning },
        },
      };
    }

    // The saved model's ladder travels with the config, so the control is
    // rendered from its descriptor. Nothing here knows which provider is active.
    it("labels the control with the provider's own word and offers exactly that model's levels", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      const select = await screen.findByLabelText(/^effort$/i);
      const options = within(select).getAllByRole("option");

      expect(options.map((o) => o.textContent)).toEqual([
        "Off",
        "Max",
        "High",
        "Medium",
        "Low",
      ]);
    });

    // The control describes a model that is already chosen, so making it wait
    // on the catalog would move the form under the operator for no reason.
    it("is on screen before the catalog has answered", async () => {
      const user = userEvent.setup();
      // A catalog that never resolves: the control must not depend on it.
      setup(undefined, new Promise<ModelCatalog>(() => {}));
      await openSection(user, /provider/i);

      expect(await screen.findByLabelText(/^effort$/i)).toBeInTheDocument();
      await openModelList(user);
      expect(await screen.findByText(/loading models/i)).toBeInTheDocument();
    });

    it("offers no off switch for a model that rejects being switched off", async () => {
      const user = userEvent.setup();
      setup(
        withLadder({
          label: "Reasoning",
          levels: [{ value: "medium", label: "Medium" }],
          defaultLevel: "medium",
          canDisable: false,
        }),
      );
      await openSection(user, /provider/i);

      const select = await screen.findByLabelText(/^reasoning$/i);

      expect(
        within(select).queryByRole("option", { name: "Off" }),
      ).not.toBeInTheDocument();
    });

    it("shows no reasoning control at all for a model that advertises none", async () => {
      const user = userEvent.setup();
      setup(withLadder(null));
      await openSection(user, /provider/i);

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      expect(screen.queryByLabelText(/^effort$/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/^reasoning$/i)).not.toBeInTheDocument();
    });

    it("takes the new model's ladder when the model changes", async () => {
      const user = userEvent.setup();
      setup(withLadder(null), {
        ok: true,
        models: [
          {
            id: "openai/gpt-5",
            reasoning: {
              label: "Reasoning",
              levels: [
                { value: "high", label: "High" },
                { value: "low", label: "Low" },
              ],
              defaultLevel: "low",
              canDisable: false,
            },
            maxOutputTokens: null,
          },
        ],
      });
      await openSection(user, /provider/i);

      const input = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.clear(input);
      await user.type(input, "openai/gpt-5");
      await user.click(await screen.findByRole("option", { name: /gpt-5/ }));

      const select = await screen.findByLabelText(/^reasoning$/i);
      // The new model's own default, not whatever the previous one was set to.
      expect(
        within(select).getByRole("option", { selected: true }),
      ).toHaveValue("low");
    });
  });

  describe("provider picker", () => {
    it("offers whatever the server says it can reach, rather than a list the console keeps", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      const picker = await screen.findByLabelText(/^provider$/i, {
        selector: "select",
      });

      expect(
        within(picker)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Select a provider", "Anthropic", "OpenRouter"]);
    });

    it("takes the Base URL placeholder from the provider's own default", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      expect(await screen.findByLabelText(/base url/i)).toHaveAttribute(
        "placeholder",
        "https://api.anthropic.com",
      );
    });
  });

  describe("stored API key", () => {
    const withStoredKey = {
      ...CONFIG,
      providers: {
        ...CONFIG.providers,
        anthropic: {
          ...CONFIG.providers.anthropic,
          apiKeyMasked: "sk-...9999",
        },
      },
    };

    it("shows the saved key masked, with no input open until Replace is pressed", async () => {
      const user = userEvent.setup();
      setup(withStoredKey);
      await openSection(user, /provider/i);

      expect(await screen.findByText("sk-...9999")).toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText(/paste api key/i),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /replace/i }));

      expect(
        await screen.findByPlaceholderText(/paste api key/i),
      ).toBeInTheDocument();
    });

    it("loads the catalog with the saved key, without it being retyped", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup(withStoredKey);
      await openSection(user, /provider/i);

      await waitFor(() => {
        const call = fetchMock.mock.calls.find(
          ([url, init]) =>
            (url as string).includes("/config/models") &&
            (init as RequestInit | undefined)?.method === "POST",
        );
        expect(call).toBeDefined();
        const body = JSON.parse((call?.[1] as RequestInit).body as string) as {
          apiKey?: string;
          provider: string;
        };
        // No key travels when none was typed: the server uses the stored one.
        expect(body.apiKey).toBeUndefined();
        expect(body.provider).toBe("anthropic");
      });
    });
  });

  describe("Limits", () => {
    it("shows durations in the unit a person would say them in", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /limits/i);

      // 1800000 ms is thirty minutes; nobody should have to do that division.
      expect(await screen.findByLabelText(/check in after/i)).toHaveValue(30);
      expect(screen.getByLabelText(/^maximum$/i)).toHaveValue(10);
      expect(screen.getByLabelText(/^timeout$/i)).toHaveValue(120);
    });

    it("saves the value converted back to milliseconds", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /limits/i);

      const checkIn = await screen.findByLabelText(/check in after/i);
      await user.clear(checkIn);
      await user.type(checkIn, "45");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => {
        const patch = fetchMock.mock.calls.find(
          ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
        );
        expect(patch).toBeDefined();
        const body = JSON.parse((patch?.[1] as RequestInit).body as string) as {
          checkInAfterMs: number;
        };
        expect(body.checkInAfterMs).toBe(2_700_000);
      });
    });
  });

  describe("API key", () => {
    it("carries a freshly typed key on the catalog request, which is what verifies it", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /provider/i);

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-ant-newkey");

      // Debounced, so this is the request that lands after typing stops.
      await waitFor(
        () => {
          const withKey = fetchMock.mock.calls.filter(
            ([url, init]) =>
              (url as string).includes("/config/models") &&
              String((init as RequestInit | undefined)?.body).includes(
                "sk-ant-newkey",
              ),
          );
          expect(withKey.length).toBe(1);
        },
        { timeout: 3000 },
      );
    });

    it("shows the reason inline when the catalog rejects the key", async () => {
      const user = userEvent.setup();
      setup(undefined, { ok: false, error: "bad_key" });
      await openSection(user, /provider/i);
      await openModelList(user);

      expect(
        await screen.findByText(/that key was rejected/i),
      ).toBeInTheDocument();
    });

    it("says an endpoint could not be reached, which is a different mistake", async () => {
      const user = userEvent.setup();
      setup(undefined, { ok: false, error: "unreachable" });
      await openSection(user, /provider/i);
      await openModelList(user);

      expect(
        await screen.findByText(/could not reach that endpoint/i),
      ).toBeInTheDocument();
    });

    it("enables Save as soon as anything is edited", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-ant-newkey");

      expect(
        screen.getByRole("button", { name: /^save$/i }),
      ).not.toBeDisabled();
    });

    it("PATCHes /config/key on Save, before the config that depends on it", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /provider/i);

      const keyInput = await screen.findByPlaceholderText(/paste api key/i);
      await user.type(keyInput, "sk-ant-newkey");
      await user.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => {
        const keyCall = fetchMock.mock.calls.findIndex(
          ([url, init]) =>
            (url as string).includes("/config/key") &&
            (init as RequestInit | undefined)?.method === "PATCH",
        );
        expect(keyCall).toBeGreaterThan(-1);
        const body = JSON.parse(
          (fetchMock.mock.calls[keyCall]?.[1] as RequestInit).body as string,
        ) as { apiKey: string; provider: string };
        expect(body.apiKey).toBe("sk-ant-newkey");
        expect(body.provider).toBe("anthropic");
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
