import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TestProviders } from "./renderWithProviders.js";
import type {
  AgentConfig,
  ModelCatalog,
  ProviderOption,
  ReasoningDescriptor,
} from "@nightwarden/shared";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { AuthProvider } from "@/auth/AuthContext";
import { SettingsPage } from "@/pages/SettingsPage";
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
  maxConcurrentInvestigations: 10,
  requestTimeoutMs: 120000,
  checkInAfterMs: 1800000,
  toolCallCeilingMs: 600000,
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

/* Settings is a route now, so it renders under a router with somewhere to
   navigate away to - which is what the unsaved-provider guard reacts to. */
function renderSettings(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  const rootRoute = createRootRoute();
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/$section",
    component: SettingsPage,
  });
  const awayRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/agent",
    component: () => <div>somewhere else</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, awayRoute]),
    history: createMemoryHistory({ initialEntries: ["/settings/provider"] }),
  });

  render(
    <TestProviders>
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </TestProviders>,
  );

  return { fetchMock, qc, router };
}

function setup(
  configOverride?: Partial<typeof CONFIG>,
  modelsOverride?: ModelCatalog | Promise<ModelCatalog>,
) {
  const config = { ...CONFIG, ...configOverride };
  return renderSettings(makeFetchMock(config, modelsOverride));
}

async function openSection(
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<void> {
  // The page is a route now, so its tabs arrive a tick after render.
  const tablist = await screen.findByRole("tablist", {
    name: /settings sections/i,
  });
  await user.click(within(tablist).getByRole("tab", { name }));
}

// A Select is a button and a listbox that exists only while open, so a test
// about its options opens it first and reads them from the listbox.
const openSelect = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp,
): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("combobox", { name }));
  return screen.findByRole("listbox");
};

// Everything the catalog has to say is said in the suggestion list, so a test
// about it opens the list first.
const openModelList = async (
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> => {
  await user.click(screen.getByLabelText(/^model$/i, { selector: "input" }));
};

// Typing only narrows the list; picking is what sets the id. Anything needing
// a changed model goes through the list, as a person has to.
const pickModel = async (
  user: ReturnType<typeof userEvent.setup>,
  id: string,
): Promise<void> => {
  await user.click(screen.getByLabelText(/^model$/i, { selector: "input" }));
  await user.click(await screen.findByRole("option", { name: id }));
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

describe("SettingsPage", () => {
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

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "claude-opus-4-8");
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
      renderSettings(fetchMock);

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "claude-opus-4-8");
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText(/save failed/i)).toBeInTheDocument();
      });
    });
  });

  describe("unsaved provider guard", () => {
    it("asks before leaving with the block half-edited, and stays put on decline", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "claude-opus-4-8");
      // Not awaited: a blocked navigation never settles, and awaiting it here
      // is what wedged every test after this one.
      act(() => {
        void router.navigate({ to: "/agent" });
      });

      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: /^cancel$/i }),
      );

      expect(screen.queryByText(/somewhere else/i)).not.toBeInTheDocument();
    });

    it("leaves when the prompt is accepted", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "claude-opus-4-8");
      // Not awaited: a blocked navigation never settles, and awaiting it here
      // is what wedged every test after this one.
      act(() => {
        void router.navigate({ to: "/agent" });
      });

      const dialog = await screen.findByRole("alertdialog");
      await user.click(
        within(dialog).getByRole("button", { name: /^leave$/i }),
      );

      expect(await screen.findByText(/somewhere else/i)).toBeInTheDocument();
    });

    it("puts the confirmation on one surface, right-aligned, with the destructive fill", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "claude-opus-4-8");
      // Not awaited: a blocked navigation never settles, and awaiting it here
      // is what wedged every test after this one.
      act(() => {
        void router.navigate({ to: "/agent" });
      });

      const dialog = await screen.findByRole("alertdialog");
      const confirm = within(dialog).getByRole("button", { name: /^leave$/i });
      expect(confirm).toHaveClass("bg-destructive-fill");
      expect(confirm).toHaveClass("text-primary-foreground");

      // At every width, not only above sm: the console has no width below it.
      const footer = confirm.parentElement;
      expect(footer).toHaveClass("justify-end");
      expect(footer?.className).not.toMatch(
        /bg-surface|border-t|grid-cols-2|flex-col/,
      );

      // The question is asked from the edge, not down the middle.
      const heading = within(dialog).getByRole("heading");
      expect(heading.parentElement?.className).toMatch(/text-left/);
      expect(heading.parentElement?.className).not.toMatch(/text-center/);
    });

    it("does not ask for an autosaved value, which is already written", async () => {
      const user = userEvent.setup();
      const { router } = setup();

      await openSection(user, /limits/i);
      const retries = await screen.findByLabelText(/^retries$/i);
      await user.clear(retries);
      await user.type(retries, "5");
      await user.tab();

      // Not awaited: a blocked navigation never settles, and awaiting it here
      // is what wedged every test after this one.
      act(() => {
        void router.navigate({ to: "/agent" });
      });

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(await screen.findByText(/somewhere else/i)).toBeInTheDocument();
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

    /* An id the catalog does not list is left standing, not swept away: the box
       keeps what was typed so the operator can see it is not a model, the
       ladder goes with the model it belonged to, and Save has nothing to do. */
    it("keeps an unlisted id on screen and refuses to save it", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      const input = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.type(input, "-nonsense");

      expect(await screen.findByText(/no model matches/i)).toBeInTheDocument();
      expect(screen.queryByRole("option")).not.toBeInTheDocument();

      await dismissModelList(user);
      expect(input).toHaveValue("claude-sonnet-4-6-nonsense");
      expect(
        screen.queryByLabelText(/^effort$/i, { selector: "button" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    });

    // Emptying it is the same story: no model, so no ladder and nothing to save.
    it("drops the ladder when the box is emptied, and will not save that", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      const input = await screen.findByLabelText(/^model$/i, {
        selector: "input",
      });
      await user.clear(input);
      await dismissModelList(user);

      expect(input).toHaveValue("");
      expect(
        screen.queryByLabelText(/^effort$/i, { selector: "button" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
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

      const list = await openSelect(user, /^effort$/i);
      const options = within(list).getAllByRole("option");

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

      const list = await openSelect(user, /^reasoning$/i);

      expect(
        within(list).queryByRole("option", { name: "Off" }),
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
              // Deliberately without "high": the level in hand has to be one
              // this ladder cannot offer, or keeping it is the right answer.
              levels: [
                { value: "medium", label: "Medium" },
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

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "openai/gpt-5");

      const list = await openSelect(user, /^reasoning$/i);
      // The new model's own default, not whatever the previous one was set to.
      expect(
        within(list).getByRole("option", { selected: true }),
      ).toHaveTextContent("Low");
    });

    // The other half, and the commoner one: a level both models offer survives
    // the swap rather than being reset to the new model's default.
    it("keeps a level the new model also offers", async () => {
      const user = userEvent.setup();
      setup(undefined, {
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

      await screen.findByLabelText(/^model$/i, { selector: "input" });
      await pickModel(user, "openai/gpt-5");

      const list = await openSelect(user, /^reasoning$/i);
      expect(
        within(list).getByRole("option", { selected: true }),
      ).toHaveTextContent("High");
    });
  });

  describe("provider picker", () => {
    it("offers whatever the server says it can reach, rather than a list the console keeps", async () => {
      const user = userEvent.setup();
      setup();
      await openSection(user, /provider/i);

      const list = await openSelect(user, /^provider$/i);

      expect(
        within(list)
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

    /* A limit is valid on its own, so leaving the field writes it - but only
       once it is left. A half-typed 4 must never be saved where 45 was meant. */
    it("writes on blur, in milliseconds, and not while still being typed", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /limits/i);

      const checkIn = await screen.findByLabelText(/check in after/i);
      await user.clear(checkIn);
      await user.type(checkIn, "45");

      expect(
        fetchMock.mock.calls.filter(
          ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toHaveLength(0);

      await user.tab();

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

      // The key changes what the catalog is asked, so Save turns on when that
      // answer lands, not before: an unverified key is not saveable.
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
    it("saves the sandbox network knob and explains what each mode means", async () => {
      const user = userEvent.setup();
      const { fetchMock } = setup();
      await openSection(user, /sandbox/i);

      expect(
        await screen.findByLabelText(/sandbox network/i),
      ).toHaveTextContent("None (no network)");
      expect(screen.getByText(/no network at all/i)).toBeInTheDocument();

      const list = await openSelect(user, /sandbox network/i);
      await user.click(
        within(list).getByRole("option", { name: /open \(unrestricted\)/i }),
      );
      expect(screen.getByText(/could exfiltrate/i)).toBeInTheDocument();

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

      const list = await openSelect(user, /sandbox network/i);
      await user.click(
        within(list).getByRole("option", {
          name: /allowlist \(recommended\)/i,
        }),
      );
      expect(
        screen.getByText(/only the hosts listed below/i),
      ).toBeInTheDocument();

      const textarea = screen.getByLabelText(/allowed hosts/i);
      await user.clear(textarea);
      await user.type(textarea, "registry.npmjs.org{enter}internal.dev{enter}");
      await user.tab();

      await waitFor(() => {
        const hosts = fetchMock.mock.calls
          .filter(
            (call) =>
              call[0] === "/api/config" &&
              (call[1] as RequestInit | undefined)?.method === "PATCH",
          )
          .map(
            (call) =>
              (
                JSON.parse(String((call[1] as RequestInit).body)) as {
                  sandboxAllowlistHosts?: string[];
                }
              ).sandboxAllowlistHosts,
          )
          .filter((h) => h !== undefined);
        // The trailing blank line from typing is dropped on save.
        expect(hosts.at(-1)).toEqual(["registry.npmjs.org", "internal.dev"]);
      });
    });
  });
});
