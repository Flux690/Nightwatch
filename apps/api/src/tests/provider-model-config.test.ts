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
import type { AgentConfig, ModelOption } from "@nightwarden/shared";
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

// One entry of Anthropic's /v1/models, with the effort levels under test.
// low/medium/high are non-null in the schema; xhigh is nullable.
function anthropicModel(
  id: string,
  effort: { xhigh?: boolean; max?: boolean },
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
      method: "GET",
      url: "/api/config/models",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    expect(res.statusCode).toBe(200);
    return (JSON.parse(res.body) as { models: ModelOption[] }).models;
  }

  // Switches the active block so the route derives through OpenRouter's rules.
  function useOpenRouter(): void {
    updateProvider("openrouter", {
      model: "anthropic/claude-opus-5",
      apiKey: "sk-or-key",
    });
    updateConfig({ provider: "openrouter" });
  }

  // --- POST /config/test ---

  it("POST /config/test: returns { ok: false, error: bad_key } when upstream responds 401", async () => {
    stubFetch(() => mockResponse(401, {}));

    const res = await server.inject({
      method: "POST",
      url: "/api/config/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { apiKey: "sk-bad-key" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: "bad_key" });
  });

  it("POST /config/test: returns { ok: true } when upstream responds 200 and model is in the list", async () => {
    stubFetch(() =>
      mockResponse(200, {
        data: [{ id: "claude-sonnet-4-6" }, { id: "claude-opus-4-8" }],
      }),
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/config/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { apiKey: "sk-ant-valid-key", model: "claude-sonnet-4-6" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("POST /config/test: returns { ok: false, error: unknown_model } when model not in list", async () => {
    stubFetch(() =>
      mockResponse(200, {
        data: [{ id: "claude-sonnet-4-6" }],
      }),
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/config/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { apiKey: "sk-ant-valid-key", model: "gpt-99-not-real" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: "unknown_model" });
  });

  it("POST /config/test: returns { ok: false, error: unreachable } on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/config/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { apiKey: "sk-any-key" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: "unreachable" });
  });

  it("POST /config/test: never persists the key, even on a successful probe", async () => {
    stubFetch(() => mockResponse(200, { data: [{ id: "claude-sonnet-4-6" }] }));

    const res = await server.inject({
      method: "POST",
      url: "/api/config/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: {
        apiKey: "sk-ant-should-not-persist",
        model: "claude-sonnet-4-6",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });

    const configRes = await server.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: `nw_auth=${SESSION}` },
    });
    const body = JSON.parse(configRes.body) as {
      providers: { anthropic: { apiKeyMasked: string | null } };
    };
    expect(body.providers.anthropic.apiKeyMasked).toBeNull();
  });

  it("POST /config/test: probes against a provider/baseUrl override instead of the persisted config", async () => {
    let requestedUrl = "";
    stubFetch((url) => {
      requestedUrl = url;
      return mockResponse(200, { data: [{ id: "some-model" }] });
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/config/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: {
        apiKey: "sk-or-key",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "some-model",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(requestedUrl).toBe("https://openrouter.ai/api/v1/models");
  });

  // --- GET /config/models ---

  it("GET /config/models: returns 401 without a valid nw_auth cookie", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/config/models",
    });

    expect(res.statusCode).toBe(401);
  });

  it("GET /config/models: returns models proxied from upstream endpoint", async () => {
    stubFetch(() =>
      mockResponse(200, {
        data: [
          { id: "claude-sonnet-4-6" },
          { id: "claude-opus-4-8" },
          { id: "claude-haiku-4-5-20251001" },
        ],
      }),
    );

    const res = await server.inject({
      method: "GET",
      url: "/api/config/models",
      headers: { cookie: `nw_auth=${SESSION}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { models: ModelOption[] };
    expect(body.models.map((m) => m.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-8",
      "claude-haiku-4-5-20251001",
    ]);
  });

  it("GET /config/models: returns empty models array when upstream call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    const res = await server.inject({
      method: "GET",
      url: "/api/config/models",
      headers: { cookie: `nw_auth=${SESSION}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { models: ModelOption[] };
    expect(body.models).toEqual([]);
  });

  // --- what picking a model captures ---

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
      expect(config.providers.anthropic.reasoningCanDisable).toBe(true);
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

    it("OpenRouter: carries its own free-tier caution, so the console never has to know what :free means", async () => {
      useOpenRouter();
      stubFetch(() =>
        mockResponse(200, {
          data: [
            { id: "openai/gpt-oss-20b:free", reasoning: { mandatory: true } },
            { id: "openai/gpt-oss-20b", reasoning: { mandatory: true } },
          ],
        }),
      );

      const models = await getModels();

      expect(models[0]?.notice).toContain("20 requests a minute");
      expect(models[1]?.notice).toBeNull();
    });

    it("Anthropic: has no free tier, so no model carries a caution", async () => {
      stubFetch(() =>
        mockResponse(200, {
          data: [anthropicModel("claude-opus-5", { max: true })],
        }),
      );

      const models = await getModels();

      expect(models[0]?.notice).toBeNull();
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

  // --- requireSession gate ---

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

  // --- PATCH /config/key ---

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

  // --- no invented defaults ---

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
      // Timeouts and sandbox limits are engineering choices, not the operator's;
      // a provider's own tuning defaults the same way inside its block.
      expect(body.sandboxNetwork).toBe("allowlist");
      expect(body.checkInAfterMs).toEqual(expect.any(Number));
    });

    it("GET /config/models returns nothing instead of probing a guessed endpoint", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const res = await server.inject({
        method: "GET",
        url: "/api/config/models",
        headers: { cookie: `nw_auth=${SESSION}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ models: [] });
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
