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
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerConfigRoutes } from "../config/routes.js";
import { clearTestLLM, configureTestLLM, useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { updateConfig, updateProvider } from "../config/store.js";
import type {
  AgentConfig,
  ModelCatalog,
  ModelOption,
  ProviderOption,
} from "@nightwarden/shared";
import { mountApi } from "./api-server.js";

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

// One entry of Anthropic's /v1/models. low/medium/high are non-null in the
// schema; xhigh is nullable. Context management is omitted unless a case asks,
// which is the shape a model that cannot compact answers with.
function anthropicModel(
  id: string,
  effort: { xhigh?: boolean; max?: boolean },
  contextManagement?: { compact: boolean },
): Record<string, unknown> {
  return {
    id,
    capabilities: {
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        max: { supported: effort.max ?? false },
        xhigh: effort.xhigh === undefined ? null : { supported: effort.xhigh },
      },
      thinking: {
        supported: true,
        types: { adaptive: { supported: true }, enabled: { supported: true } },
      },
      ...(contextManagement !== undefined && {
        context_management: {
          supported: true,
          clear_thinking_20251015: null,
          clear_tool_uses_20250919: null,
          compact_20260112: { supported: contextManagement.compact },
        },
      }),
    },
  };
}

describe("provider/model config seam", () => {
  let server: FastifyInstance;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    vi.stubEnv("SECRET_KEY", "test-secret-key-for-aes256-gcm-!!!");
    SESSION = await mintTestSession();
    server = Fastify({ logger: false });
    await mountApi(server, registerConfigRoutes);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function getModels(): Promise<ModelOption[]> {
    const res = await server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as ModelCatalog;
    if (!body.ok) throw new Error(`catalog failed: ${body.error}`);
    return body.models;
  }

  async function storedMask(): Promise<string | null> {
    const res = await server.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    const config = JSON.parse(res.body) as AgentConfig;
    return config.providers.anthropic.apiKeyMasked ?? null;
  }

  // Switches the active block so the route derives through OpenRouter's rules.
  function useOpenRouter(): void {
    updateProvider("openrouter", {
      model: "anthropic/claude-opus-5",
      apiKey: "sk-or-key",
    });
    updateConfig({ provider: "openrouter" });
  }

  // Listing the catalog is also how a block is verified, so these cover both.

  it("POST /config/models: rejects a bad key, which is how a wrong key is reported", async () => {
    stubFetch(() => mockResponse(401, {}));

    const res = await server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `nw_auth=${SESSION}` },
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

    const res = await server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `nw_auth=${SESSION}` },
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
        requestedUrl = url;
        sawAuth = String(
          (init?.headers as Record<string, string> | undefined)?.[
            "Authorization"
          ],
        );
        return Promise.resolve(
          mockResponse(200, { data: [{ id: "some/model" }] }),
        );
      }),
    );

    // Nothing here is stored: the active provider is still Anthropic.
    const res = await server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-typed",
      },
    });

    const body = JSON.parse(res.body) as { ok: true; models: ModelOption[] };
    expect(body.models.map((m) => m.id)).toEqual(["some/model"]);
    expect(requestedUrl).toBe("https://openrouter.ai/api/v1/models");
    expect(sawAuth).toBe("Bearer sk-or-typed");
  });

  it("POST /config/models: falls back to the saved key when none is typed", async () => {
    // Written here rather than relying on the fixture: the stored key is
    // encrypted with whichever SECRET_KEY was live when it was written.
    updateProvider("anthropic", { apiKey: "saved-key" });
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

    const res = await server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: {},
    });

    expect((JSON.parse(res.body) as { ok: boolean }).ok).toBe(true);
    expect(sawAuth).toBe("saved-key");
  });

  // Whether a catalog can be read without a key is the provider's rule, so each
  // one answers for itself and the console is told which case it is in.
  it("POST /config/models: Anthropic asks for a key rather than being called with none", async () => {
    clearTestLLM();
    const calls = vi.fn();
    vi.stubGlobal("fetch", calls);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/config/models",
        headers: { cookie: `nw_auth=${SESSION}` },
        payload: { provider: "anthropic" },
      });

      expect(JSON.parse(res.body)).toEqual({ ok: false, error: "needs_key" });
      // Asking anyway would come back 401 and be reported as a rejected key.
      expect(calls).not.toHaveBeenCalled();
    } finally {
      configureTestLLM();
    }
  });

  it("POST /config/models: OpenRouter lists models with no key, because it publishes them", async () => {
    clearTestLLM();
    stubFetch(() => mockResponse(200, { data: [{ id: "openai/gpt-5" }] }));
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/config/models",
        headers: { cookie: `nw_auth=${SESSION}` },
        payload: { provider: "openrouter" },
      });

      expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    } finally {
      configureTestLLM();
    }
  });

  it("POST /config/models: never persists what it was asked about", async () => {
    stubFetch(() => mockResponse(200, { data: [{ id: "claude-sonnet-4-6" }] }));
    const maskBefore = await storedMask();

    await server.inject({
      method: "POST",
      url: "/api/config/models",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { apiKey: "sk-ant-should-not-persist", provider: "anthropic" },
    });

    expect(await storedMask()).toBe(maskBefore);
    expect(await storedMask()).not.toContain("persist");
  });

  it("GET /config/providers: serves the picker so the console keeps no provider list of its own", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/config/providers",
      headers: { cookie: `nw_auth=${SESSION}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { providers: ProviderOption[] };
    expect(body.providers.map((p) => p.name)).toEqual([
      "anthropic",
      "openrouter",
    ]);
    // The endpoint each adapter falls back to, so the form can show it as a
    // placeholder without knowing either provider's address.
    expect(
      body.providers.find((p) => p.name === "openrouter")?.defaultBaseUrl,
    ).toBe("https://openrouter.ai/api/v1");
  });

  it("GET /config/providers: returns 401 without a valid nw_auth cookie", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/config/providers",
    });

    expect(res.statusCode).toBe(401);
  });

  it("POST /config/models: returns 401 without a valid nw_auth cookie", async () => {
    const res = await server.inject({
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
    afterEach(() => {
      configureTestLLM();
    });

    async function patchModel(
      model: string,
      reasoningLevel?: string,
    ): Promise<AgentConfig> {
      const res = await server.inject({
        method: "PATCH",
        url: "/api/config",
        headers: { cookie: `nw_auth=${SESSION}` },
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
      stubFetch(() =>
        mockResponse(200, {
          data: [
            {
              ...anthropicModel("claude-opus-5", { max: true }),
              max_tokens: 128_000,
            },
          ],
        }),
      );

      const config = await patchModel("claude-opus-5");

      expect(config.providers.anthropic.maxOutputTokens).toBe(128_000);
      // The whole ladder is captured with the model, so the settings form draws
      // its control from the config instead of asking the catalog again.
      expect(config.providers.anthropic.reasoning).toEqual({
        label: "Effort",
        levels: [
          { value: "max", label: "Max" },
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        defaultLevel: "high",
        canDisable: true,
      });
    });

    it("captures the context window and compaction support, so nothing reaches the network to start a run", async () => {
      stubFetch(() =>
        mockResponse(200, {
          data: [
            {
              ...anthropicModel(
                "claude-opus-5",
                { max: true },
                { compact: true },
              ),
              max_input_tokens: 200_000,
            },
          ],
        }),
      );

      const first = await patchModel("claude-opus-5");
      expect(first.providers.anthropic.maxInputTokens).toBe(200_000);
      expect(first.providers.anthropic.compaction).toBe(true);

      // A model that cannot compact must clear both, or the next run compacts
      // against a window belonging to the model before it.
      stubFetch(() =>
        mockResponse(200, {
          data: [anthropicModel("claude-small", {})],
        }),
      );
      const second = await patchModel("claude-small");

      expect(second.providers.anthropic.compaction).toBe(false);
      expect(second.providers.anthropic.maxInputTokens).toBeNull();
    });

    it("re-resolves a level the new model does not support, rather than storing something unsendable", async () => {
      // max is legal on the first model and absent from the second.
      stubFetch(() =>
        mockResponse(200, {
          data: [anthropicModel("claude-opus-5", { max: true })],
        }),
      );
      const first = await patchModel("claude-opus-5", "max");
      expect(first.providers.anthropic.reasoningLevel).toBe("max");

      stubFetch(() =>
        mockResponse(200, {
          data: [anthropicModel("claude-small", {})],
        }),
      );
      const second = await patchModel("claude-small");

      expect(second.providers.anthropic.reasoningLevel).toBe("high");
    });

    it("leaves the level unset when the new model advertises no reasoning at all", async () => {
      stubFetch(() =>
        mockResponse(200, {
          data: [anthropicModel("claude-opus-5", { max: true })],
        }),
      );
      await patchModel("claude-opus-5", "max");

      stubFetch(() =>
        mockResponse(200, {
          data: [{ id: "claude-plain", capabilities: null }],
        }),
      );
      const config = await patchModel("claude-plain");

      expect(config.providers.anthropic.reasoningLevel).toBeNull();
    });

    it("stores the model anyway when the catalog cannot be reached, rather than refusing the save", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("fetch failed")),
      );

      const config = await patchModel("claude-opus-5");

      expect(config.providers.anthropic.model).toBe("claude-opus-5");
      expect(config.providers.anthropic.maxOutputTokens).toBeNull();
    });
  });

  // --- reasoning descriptors, derived from each provider's own catalog ---

  describe("reasoning descriptors", () => {
    // Anthropic is the baseline useTempDb installs; a test that switches to
    // OpenRouter must not leak that choice into the next one.
    afterEach(() => {
      configureTestLLM();
    });

    it("Anthropic: derives levels from capabilities.effort and defaults to high, which is the documented API default", async () => {
      stubFetch(() =>
        mockResponse(200, {
          data: [anthropicModel("claude-opus-5", { xhigh: true, max: true })],
        }),
      );

      const models = await getModels();

      expect(models[0]?.reasoning).toEqual({
        label: "Effort",
        levels: [
          { value: "max", label: "Max" },
          { value: "xhigh", label: "Extra high" },
          { value: "high", label: "High" },
          { value: "medium", label: "Medium" },
          { value: "low", label: "Low" },
        ],
        defaultLevel: "high",
        canDisable: true,
      });
    });

    it("Anthropic: omits a level the model does not support, so a ladder with holes stays honest", async () => {
      // Opus 4.6 supports max but not xhigh: the ladder is not monotonic.
      stubFetch(() =>
        mockResponse(200, {
          data: [
            anthropicModel("claude-opus-4-6", { xhigh: false, max: true }),
          ],
        }),
      );

      const models = await getModels();

      expect(models[0]?.reasoning?.levels.map((l) => l.value)).toEqual([
        "max",
        "high",
        "medium",
        "low",
      ]);
    });

    it("Anthropic: reports no reasoning control when capabilities is null", async () => {
      stubFetch(() =>
        mockResponse(200, {
          data: [{ id: "claude-legacy", capabilities: null }],
        }),
      );

      const models = await getModels();

      expect(models[0]?.reasoning).toBeNull();
    });

    it("Anthropic: carries the model's own max_tokens ceiling", async () => {
      stubFetch(() =>
        mockResponse(200, {
          data: [
            { ...anthropicModel("claude-opus-5", {}), max_tokens: 128_000 },
            { ...anthropicModel("claude-old", {}), max_tokens: null },
          ],
        }),
      );

      const models = await getModels();

      expect(models[0]?.maxOutputTokens).toBe(128_000);
      expect(models[1]?.maxOutputTokens).toBeNull();
    });

    it("Anthropic: carries the context window and whether the model can compact", async () => {
      stubFetch(() =>
        mockResponse(200, {
          data: [
            {
              ...anthropicModel("claude-opus-5", {}, { compact: true }),
              max_input_tokens: 200_000,
            },
            {
              ...anthropicModel("claude-opus-4-6", {}, { compact: false }),
              max_input_tokens: 200_000,
            },
            { ...anthropicModel("claude-legacy", {}), max_input_tokens: null },
          ],
        }),
      );

      const models = await getModels();

      expect(models[0]?.maxInputTokens).toBe(200_000);
      expect(models[0]?.compaction).toBe(true);
      // Advertised but unsupported is a no, and so is saying nothing at all:
      // compaction is only ever offered where the catalog states it.
      expect(models[1]?.compaction).toBe(false);
      expect(models[2]?.compaction).toBe(false);
      expect(models[2]?.maxInputTokens).toBeNull();
    });

    it("OpenRouter: never claims compaction, which the gateway truncates instead of summarising", async () => {
      useOpenRouter();
      stubFetch(() =>
        mockResponse(200, {
          data: [{ id: "some/model", reasoning: { mandatory: false } }],
        }),
      );

      const models = await getModels();

      expect(models[0]?.compaction).toBe(false);
      expect(models[0]?.maxInputTokens).toBeNull();
    });

    it("OpenRouter: uses the model's stated levels and its own default, never a guessed one", async () => {
      useOpenRouter();
      // kimi-k3 publishes no medium at all, and states max as its default.
      stubFetch(() =>
        mockResponse(200, {
          data: [
            {
              id: "moonshotai/kimi-k3",
              reasoning: {
                mandatory: false,
                supported_efforts: ["max", "high", "low"],
                default_effort: "max",
              },
            },
          ],
        }),
      );

      const models = await getModels();

      expect(models[0]?.reasoning?.label).toBe("Reasoning");
      expect(models[0]?.reasoning?.levels.map((l) => l.value)).toEqual([
        "max",
        "high",
        "low",
      ]);
      expect(models[0]?.reasoning?.defaultLevel).toBe("max");
    });

    it("OpenRouter: offers the full gateway ladder and medium when the model publishes no levels", async () => {
      useOpenRouter();
      stubFetch(() =>
        mockResponse(200, {
          data: [{ id: "some/model", reasoning: { mandatory: false } }],
        }),
      );

      const models = await getModels();

      expect(models[0]?.reasoning?.levels.map((l) => l.value)).toEqual([
        "max",
        "xhigh",
        "high",
        "medium",
        "low",
        "minimal",
      ]);
      expect(models[0]?.reasoning?.defaultLevel).toBe("medium");
    });

    it("OpenRouter: refuses to offer an off switch for a mandatory model, which rejects it", async () => {
      useOpenRouter();
      stubFetch(() =>
        mockResponse(200, {
          data: [
            {
              id: "openai/gpt-oss-20b:free",
              reasoning: {
                mandatory: true,
                supported_efforts: ["high", "medium", "low"],
                default_effort: "medium",
              },
            },
          ],
        }),
      );

      const models = await getModels();

      expect(models[0]?.reasoning?.canDisable).toBe(false);
    });

    it("OpenRouter: reports no reasoning control for a model with no reasoning object", async () => {
      useOpenRouter();
      stubFetch(() =>
        mockResponse(200, {
          data: [
            {
              id: "plain/model",
              top_provider: { max_completion_tokens: 8192 },
            },
          ],
        }),
      );

      const models = await getModels();

      expect(models[0]?.reasoning).toBeNull();
      expect(models[0]?.maxOutputTokens).toBe(8192);
    });
  });

  it("GET /config: returns 401 without a valid nw_auth cookie", async () => {
    const res = await server.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(401);
  });

  // --- Key never returned to browser ---

  it("GET /config: never returns apiKeyEncrypted or plaintext key in the response", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: `nw_auth=${SESSION}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    // The encrypted blob is internal and must never leave the API
    expect(body).not.toHaveProperty("apiKeyEncrypted");
    // No plaintext key field
    expect(body).not.toHaveProperty("apiKey");
  });

  it("PATCH /config/key: saves the encrypted key and returns the masked representation", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/config/key",
      headers: { cookie: `nw_auth=${SESSION}` },
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
    const saved = await server.inject({
      method: "PATCH",
      url: "/api/config/key",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { provider: "anthropic", apiKey },
    });
    expect(saved.statusCode).toBe(200);

    // GET /config reads the row, decrypts, and masks - proving the encrypt →
    // store → decrypt → mask round-trip without ever returning the plaintext.
    const res = await server.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as AgentConfig & Record<string, unknown>;
    expect(body.providers.anthropic.apiKeyMasked).toBe("sk-...9999");
    expect(body).not.toHaveProperty("apiKeyEncrypted");
    expect(JSON.stringify(body)).not.toContain(apiKey);
  });

  describe("an install nobody has configured", () => {
    beforeEach(() => {
      clearTestLLM();
    });

    afterEach(() => {
      configureTestLLM();
    });

    it("GET /config reports no provider and no model rather than guessing one, while keeping the operational defaults", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/config",
        headers: { cookie: `nw_auth=${SESSION}` },
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

      const res = await server.inject({
        method: "POST",
        url: "/api/config/models",
        headers: { cookie: `nw_auth=${SESSION}` },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, models: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("an env API key is not a live fallback: the DB is the only runtime source", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-the-environment");

      const res = await server.inject({
        method: "GET",
        url: "/api/config",
        headers: { cookie: `nw_auth=${SESSION}` },
      });

      const body = JSON.parse(res.body) as AgentConfig;
      expect(body.providers.anthropic.apiKeyMasked).toBeNull();
    });
  });
});
