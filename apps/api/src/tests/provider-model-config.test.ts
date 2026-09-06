import {
  afterEach,
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { initSecrets } from "../secrets.js";
import { harness, type Harness } from "./harness.js";
import { registerConfigRoutes } from "../config/routes.js";
import { clearTestLLM, configureTestLLM } from "./temp-db.js";
import { forgetCapabilities } from "../llm/model-capabilities.js";
import { updateConfig, updateProvider } from "../config/store.js";
import type {
  AgentConfig,
  ModelCatalog,
  ModelOption,
  ProviderOption,
} from "@nightwarden/shared";

// Builds a mock Response-like object for stubbing global fetch.
function mockResponse(
  status: number,
  body: unknown,
  ok = status >= 200 && status < 300,
) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  };
}

function stubFetch(impl: (url: string) => ReturnType<typeof mockResponse>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => Promise.resolve(impl(url))),
  );
}

/* One entry of a provider's own /models. Only the id is read from it, except on
   Anthropic, which is the one provider stating compaction support per model. */
function listed(id: string, compacts?: boolean): Record<string, unknown> {
  return {
    id,
    ...(compacts !== undefined && {
      capabilities: {
        context_management: { compact_20260112: { supported: compacts } },
      },
    }),
  };
}

// One entry of models.dev, which is where every other capability is read from.
function published(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    reasoning: true,
    reasoning_options: [
      { type: "effort", values: ["low", "medium", "high", "max"] },
    ],
    tool_call: true,
    limit: { context: 200_000, output: 64_000 },
    ...over,
  };
}

/* Serves the provider's list and the capability snapshot beside it, since a
   catalogue is read from both. The snapshot is offered under every provider. */
function stubCatalog(
  list: Array<Record<string, unknown>>,
  snapshot: Record<string, Record<string, unknown>> = {},
): void {
  forgetCapabilities();
  const models = { models: snapshot };
  stubFetch((url) =>
    url.startsWith("https://models.dev")
      ? mockResponse(200, {
          anthropic: models,
          openai: models,
          openrouter: models,
        })
      : mockResponse(200, { data: list }),
  );
}

describe("provider/model config seam", () => {
  let nw: Harness;
  let SESSION: string;

  beforeAll(async () => {
    // Before the harness: the cookie is signed with this key and the stored
    // credentials are encrypted with it, so stubbing it afterwards invalidates both.
    vi.stubEnv("NIGHTWARDEN_SECRET_KEY", "test-secret-key-for-aes256-gcm-!!!");
    initSecrets();
    nw = await harness({ routes: [registerConfigRoutes] });
    SESSION = nw.session;
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function getModels(): Promise<ModelOption[]> {
    const res = await nw.server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `${SESSION}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ModelCatalog;
    if (!body.ok) throw new Error(`catalog failed: ${body.error}`);
    return body.models;
  }

  async function storedMask(): Promise<string | null> {
    const res = await nw.server.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: `${SESSION}` },
    });
    const config = JSON.parse(res.body) as AgentConfig;
    return config.providers.anthropic.apiKeyMasked ?? null;
  }

  // Switches the active block, so a case reads the catalogue as that provider.
  async function useProvider(name: "openai" | "openrouter"): Promise<void> {
    await updateProvider(name, { model: "a-model", apiKey: "a-key" });
    await updateConfig({ provider: name });
  }

  const useOpenAI = (): Promise<void> => useProvider("openai");
  const useOpenRouter = (): Promise<void> => useProvider("openrouter");

  // Listing the catalog is also how a block is verified, so these cover both.

  it("POST /config/models: rejects a bad key, which is how a wrong key is reported", async () => {
    stubFetch(() => mockResponse(401, {}));

    const res = await nw.server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `${SESSION}` },
      payload: { apiKey: "sk-bad-key" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: "bad_key" });
  });

  it("POST /config/models: reports an endpoint that never answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const res = await nw.server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `${SESSION}` },
      payload: { apiKey: "sk-any-key" },
    });

    expect(JSON.parse(res.body)).toEqual({ ok: false, error: "unreachable" });
  });

  it("POST /config/models: answers about an unsaved block, so the list fills in before Save", async () => {
    let requestedUrl = "";
    let sawAuth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        // The capability snapshot is fetched beside the list; this reads the list.
        if (!url.startsWith("https://models.dev")) {
          requestedUrl = url;
          sawAuth = String(
            (init?.headers as Record<string, string> | undefined)?.[
              "Authorization"
            ],
          );
        }
        return Promise.resolve(
          mockResponse(200, { data: [{ id: "some/model" }] }),
        );
      }),
    );

    // Nothing here is stored: the active provider is still Anthropic.
    const res = await nw.server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `${SESSION}` },
      payload: {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-typed",
      },
    });

    const body = JSON.parse(res.body) as { ok: true; models: ModelOption[] };
    expect(body.models.map((m) => m.id)).toEqual(["some/model"]);
    expect(requestedUrl).toBe("https://openrouter.ai/api/v1/models?limit=1000");
    expect(sawAuth).toBe("Bearer sk-or-typed");
  });

  it("POST /config/models: falls back to the saved key when none is typed", async () => {
    // Written here rather than relying on the fixture: the stored key is
    // encrypted with whichever NIGHTWARDEN_SECRET_KEY was live when it was written.
    await updateProvider("anthropic", { apiKey: "saved-key" });
    let sawAuth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        sawAuth = String(
          (init?.headers as Record<string, string> | undefined)?.["x-api-key"],
        );
        return Promise.resolve(mockResponse(200, { data: [{ id: "m" }] }));
      }),
    );

    const res = await nw.server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `${SESSION}` },
      payload: {},
    });

    expect((JSON.parse(res.body) as { ok: boolean }).ok).toBe(true);
    expect(sawAuth).toBe("saved-key");
  });

  /* The same rejection means two things, and only the key that was sent tells
     them apart. Paired with the bad-key case above, which sends one. */
  it("POST /config/models: reads a rejection carrying no key as needing one", async () => {
    await clearTestLLM();
    stubFetch(() => mockResponse(401, {}));
    try {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/config/models",
        headers: { cookie: `${SESSION}` },
        payload: { provider: "anthropic" },
      });

      expect(JSON.parse(res.body)).toEqual({ ok: false, error: "needs_key" });
    } finally {
      await configureTestLLM();
    }
  });

  it("POST /config/models: OpenRouter lists models with no key, because it publishes them", async () => {
    await clearTestLLM();
    stubFetch(() => mockResponse(200, { data: [{ id: "openai/gpt-5" }] }));
    try {
      const res = await nw.server.inject({
        method: "POST",
        url: "/api/config/models",
        headers: { cookie: `${SESSION}` },
        payload: { provider: "openrouter" },
      });

      expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    } finally {
      await configureTestLLM();
    }
  });

  it("POST /config/models: never persists what it was asked about", async () => {
    stubFetch(() => mockResponse(200, { data: [{ id: "claude-sonnet-4-6" }] }));
    const maskBefore = await storedMask();

    await nw.server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `${SESSION}` },
      payload: { apiKey: "sk-ant-should-not-persist", provider: "anthropic" },
    });

    expect(await storedMask()).toBe(maskBefore);
    expect(await storedMask()).not.toContain("persist");
  });

  it("GET /config/providers: serves the picker so the frontend keeps no provider list of its own", async () => {
    const res = await nw.server.inject({
      method: "GET",
      url: "/api/config/providers",
      headers: { cookie: `${SESSION}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { providers: ProviderOption[] };
    expect(body.providers.map((p) => p.name)).toEqual([
      "anthropic",
      "openai",
      "openrouter",
    ]);
    // The endpoint each adapter falls back to, so the form can show it as a
    // placeholder without knowing either provider's address.
    expect(
      body.providers.find((p) => p.name === "openrouter")?.defaultBaseUrl,
    ).toBe("https://openrouter.ai/api/v1");
  });

  it("GET /config/providers: returns 401 without a valid session cookie", async () => {
    const res = await nw.server.inject({
      method: "GET",
      url: "/api/config/providers",
    });

    expect(res.statusCode).toBe(401);
  });

  it("POST /config/models: returns 401 without a valid session cookie", async () => {
    const res = await nw.server.inject({
      method: "POST",
      url: "/api/config/models",
      payload: {},
    });

    expect(res.statusCode).toBe(401);
  });

  it("POST /config/models: lists what the endpoint returned", async () => {
    stubFetch(() =>
      mockResponse(200, {
        data: [
          { id: "claude-sonnet-4-6" },
          { id: "claude-opus-4-8" },
          { id: "claude-haiku-4-5-20251001" },
        ],
      }),
    );

    expect((await getModels()).map((m) => m.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-haiku-4-5-20251001",
    ]);
  });

  describe("saving a model", () => {
    afterEach(async () => {
      await configureTestLLM();
    });

    async function patchModel(
      model: string,
      reasoningLevel?: string,
    ): Promise<AgentConfig> {
      const res = await nw.server.inject({
        method: "PATCH",
        url: "/api/config",
        headers: { cookie: `${SESSION}` },
        payload: {
          providers: {
            anthropic: { model, ...(reasoningLevel && { reasoningLevel }) },
          },
        },
      });
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as AgentConfig;
    }

    it("captures the model's own ceiling, so starting a run never has to reach the network", async () => {
      stubCatalog([listed("claude-opus-5")], {
        "claude-opus-5": published({
          limit: { context: 200_000, output: 128_000 },
        }),
      });

      const config = await patchModel("claude-opus-5");

      expect(config.providers.anthropic.maxOutputTokens).toBe(128_000);
      // The whole ladder is captured with the model, so the settings form draws
      // its control from the config instead of asking the catalog again.
      expect(config.providers.anthropic.reasoning).toEqual({
        levels: [
          { value: "max", label: "Max" },
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        defaultLevel: "high",
      });
    });

    it("captures the context window and compaction support, so nothing reaches the network to start a run", async () => {
      stubCatalog([listed("claude-opus-5", true)], {
        "claude-opus-5": published(),
      });

      const first = await patchModel("claude-opus-5");
      expect(first.providers.anthropic.maxInputTokens).toBe(200_000);
      expect(first.providers.anthropic.compaction).toBe(true);

      // A model that cannot compact must clear both, or the next run compacts
      // against a window belonging to the model before it.
      stubCatalog([listed("claude-small", false)], {});
      const second = await patchModel("claude-small");

      expect(second.providers.anthropic.compaction).toBe(false);
      expect(second.providers.anthropic.maxInputTokens).toBeNull();
    });

    it("re-resolves a level the new model does not support, rather than storing something unsendable", async () => {
      // max is legal on the first model and absent from the second.
      stubCatalog([listed("claude-opus-5")], { "claude-opus-5": published() });
      const first = await patchModel("claude-opus-5", "max");
      expect(first.providers.anthropic.reasoningLevel).toBe("max");

      stubCatalog([listed("claude-small")], {
        "claude-small": published({
          reasoning_options: [
            { type: "effort", values: ["low", "medium", "high"] },
          ],
        }),
      });
      const second = await patchModel("claude-small");

      expect(second.providers.anthropic.reasoningLevel).toBe("high");
    });

    it("leaves the level unset when the new model advertises no reasoning at all", async () => {
      stubCatalog([listed("claude-opus-5")], { "claude-opus-5": published() });
      await patchModel("claude-opus-5", "max");

      stubCatalog([listed("claude-plain")], {
        "claude-plain": published({ reasoning: false, reasoning_options: [] }),
      });
      const config = await patchModel("claude-plain");

      expect(config.providers.anthropic.reasoningLevel).toBeNull();
    });

    it("stores the model anyway when the catalog cannot be reached, rather than refusing the save", async () => {
      await updateProvider("anthropic", { maxOutputTokens: null });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("fetch failed")),
      );

      const config = await patchModel("claude-opus-5");

      expect(config.providers.anthropic.model).toBe("claude-opus-5");
      expect(config.providers.anthropic.maxOutputTokens).toBeNull();
    });
  });

  /* Every capability but Anthropic's own compaction flag comes from one
     snapshot, so these cover what an id in it, and one absent from it, produce. */

  describe("model capabilities", () => {
    // Anthropic is the baseline useTempDb installs; a case that switches away
    // must not leak that choice into the next one.
    afterEach(async () => {
      await configureTestLLM();
    });

    it("reads the ladder and both limits from the snapshot", async () => {
      stubCatalog([listed("claude-opus-5")], { "claude-opus-5": published() });

      const models = await getModels();

      expect(models[0]?.reasoning).toEqual({
        levels: [
          { value: "max", label: "Max" },
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        defaultLevel: "high",
      });
      expect(models[0]?.maxInputTokens).toBe(200_000);
      expect(models[0]?.maxOutputTokens).toBe(64_000);
    });

    // A model shipped today is selectable before the snapshot describes it.
    it("offers an id the snapshot does not know, claiming nothing about it", async () => {
      stubCatalog([listed("claude-brand-new")], {});

      const models = await getModels();

      expect(models.map((m) => m.id)).toEqual(["claude-brand-new"]);
      expect(models[0]?.reasoning).toBeNull();
      expect(models[0]?.maxInputTokens).toBeNull();
      expect(models[0]?.maxOutputTokens).toBeNull();
    });

    it("drops a model that cannot call a tool, which cannot run the loop", async () => {
      stubCatalog([listed("claude-opus-5"), listed("claude-writer")], {
        "claude-opus-5": published(),
        "claude-writer": published({ tool_call: false }),
      });

      expect((await getModels()).map((m) => m.id)).toEqual(["claude-opus-5"]);
    });

    // A toggle is an off switch, and thinking is never switched off.
    it("reports no control for a model whose only option is a toggle", async () => {
      stubCatalog([listed("some-model")], {
        "some-model": published({ reasoning_options: [{ type: "toggle" }] }),
      });

      expect((await getModels())[0]?.reasoning).toBeNull();
    });

    it("never offers an off switch among the levels", async () => {
      stubCatalog([listed("gpt-5.6")], {
        "gpt-5.6": published({
          reasoning_options: [
            { type: "effort", values: ["none", "low", "medium", "high"] },
          ],
        }),
      });

      expect(
        (await getModels())[0]?.reasoning?.levels.map((l) => l.value),
      ).toEqual(["high", "medium", "low"]);
    });

    // Anthropic documents high as equal to omitting the parameter.
    it("defaults to high, and to the strongest rung on a ladder without it", async () => {
      stubCatalog([listed("weak-model")], {
        "weak-model": published({
          reasoning_options: [{ type: "effort", values: ["low", "minimal"] }],
        }),
      });

      expect((await getModels())[0]?.reasoning?.defaultLevel).toBe("low");
    });

    it("Anthropic: takes compaction from the flag its own list carries", async () => {
      stubCatalog([listed("can-compact", true), listed("cannot", false)], {
        "can-compact": published(),
        cannot: published(),
      });

      const models = await getModels();

      expect(models[0]?.compaction).toBe(true);
      // Stated and unsupported is a no, and so is saying nothing at all.
      expect(models[1]?.compaction).toBe(false);
    });

    it("OpenAI: offers compaction on a reasoning model and on no other", async () => {
      await useOpenAI();
      stubCatalog([listed("gpt-5.6"), listed("gpt-4o")], {
        "gpt-5.6": published(),
        "gpt-4o": published({ reasoning: false, reasoning_options: [] }),
      });

      const models = await getModels();

      expect(models[0]?.compaction).toBe(true);
      expect(models[1]?.compaction).toBe(false);
    });

    // The gateway drops messages from the middle rather than summarising, which
    // in an agentic transcript is where every tool result lives.
    it("OpenRouter: never claims compaction", async () => {
      await useOpenRouter();
      stubCatalog([listed("anthropic/claude-opus-5")], {
        "anthropic/claude-opus-5": published(),
      });

      expect((await getModels())[0]?.compaction).toBe(false);
    });

    /* The snapshot is two hundred vendors in one document, and any of them can
       publish an entry this does not read. It costs that model and no other. */
    it("keeps every other model when one entry cannot be read", async () => {
      stubCatalog([listed("claude-opus-5"), listed("odd-model")], {
        "claude-opus-5": published(),
        "odd-model": published({
          reasoning_options: [{ type: "effort", values: [null] }],
        }),
      });

      const models = await getModels();

      expect(models[0]?.reasoning?.defaultLevel).toBe("high");
      expect(models[0]?.maxInputTokens).toBe(200_000);
      expect(models[1]?.reasoning).toBeNull();
      expect(models[1]?.maxInputTokens).toBeNull();
    });

    /* Capabilities change slowly, so a catalogue with no ladder is worse than a
       stale one: the last good copy stands in when a later read fails. */
    it("serves the last good snapshot when a later read fails", async () => {
      stubCatalog([listed("claude-opus-5")], { "claude-opus-5": published() });
      expect((await getModels())[0]?.reasoning).not.toBeNull();

      stubFetch((url) =>
        url.startsWith("https://models.dev")
          ? mockResponse(500, {})
          : mockResponse(200, { data: [listed("claude-opus-5")] }),
      );

      expect((await getModels())[0]?.reasoning).not.toBeNull();
    });
  });

  it("GET /config: returns 401 without a valid session cookie", async () => {
    const res = await nw.server.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(401);
  });

  // --- Key never returned to browser ---

  it("GET /config: never returns apiKeyEncrypted or plaintext key in the response", async () => {
    const res = await nw.server.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: `${SESSION}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    // The encrypted blob is internal and must never leave the API
    expect(body).not.toHaveProperty("apiKeyEncrypted");
    // No plaintext key field
    expect(body).not.toHaveProperty("apiKey");
  });

  it("PATCH /config/key: saves the encrypted key and returns the masked representation", async () => {
    const res = await nw.server.inject({
      method: "PATCH",
      url: "/api/config/key",
      headers: { cookie: `${SESSION}` },
      payload: { provider: "anthropic", apiKey: "sk-ant-test-key-12345678" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { apiKeyMasked: string };
    // Masked value must show something like "sk-...5678" (never the full key)
    expect(body.apiKeyMasked).toMatch(/\.\.\./);
    expect(body.apiKeyMasked).not.toContain("sk-ant-test-key-12345678");
  });

  it("PATCH /config/key then GET /config: persists the encrypted key and round-trips it to a mask, never the plaintext", async () => {
    const apiKey = "sk-ant-roundtrip-abcd9999";
    const saved = await nw.server.inject({
      method: "PATCH",
      url: "/api/config/key",
      headers: { cookie: `${SESSION}` },
      payload: { provider: "anthropic", apiKey },
    });
    expect(saved.statusCode).toBe(200);

    // GET /config reads the row, decrypts, and masks - proving the encrypt →
    // store → decrypt → mask round-trip without ever returning the plaintext.
    const res = await nw.server.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: `${SESSION}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as AgentConfig & Record<string, unknown>;
    expect(body.providers.anthropic.apiKeyMasked).toBe("sk-...9999");
    expect(body).not.toHaveProperty("apiKeyEncrypted");
    expect(JSON.stringify(body)).not.toContain(apiKey);
  });

  describe("an install nobody has configured", () => {
    beforeEach(async () => {
      await clearTestLLM();
    });

    afterEach(async () => {
      await configureTestLLM();
    });

    it("GET /config reports no provider and no model rather than guessing one, while keeping the operational defaults", async () => {
      const res = await nw.server.inject({
        method: "GET",
        url: "/api/config",
        headers: { cookie: `${SESSION}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as AgentConfig;
      expect(body.provider).toBeNull();
      expect(body.providers.anthropic.model).toBeNull();
      expect(body.providers.openrouter.model).toBeNull();
      expect(body.providers.anthropic.apiKeyMasked).toBeNull();
      // Timeouts and sandbox limits are engineering choices, not the user's;
      // a provider's own tuning defaults the same way inside its block.
      expect(body.sandboxNetwork).toBe("allowlist");
      expect(body.checkInAfterMs).toEqual(expect.any(Number));
    });

    it("POST /config/models returns nothing instead of probing a guessed endpoint", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const res = await nw.server.inject({
        method: "POST",
        url: "/api/config/models",
        headers: { cookie: `${SESSION}` },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, models: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("an env API key is not a live fallback: the DB is the only runtime source", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-the-environment");

      const res = await nw.server.inject({
        method: "GET",
        url: "/api/config",
        headers: { cookie: `${SESSION}` },
      });

      const body = JSON.parse(res.body) as AgentConfig;
      expect(body.providers.anthropic.apiKeyMasked).toBeNull();
    });
  });
});
