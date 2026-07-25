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
import type { AgentConfig } from "@nightwarden/shared";
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
        provider: "openai",
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

  it("GET /config/models: returns models array proxied from upstream endpoint", async () => {
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
    const body = JSON.parse(res.body) as { models: string[] };
    expect(body.models).toEqual([
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
    const body = JSON.parse(res.body) as { models: string[] };
    expect(body.models).toEqual([]);
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
      expect(body.providers.openai.model).toBeNull();
      expect(body.providers.anthropic.apiKeyMasked).toBeNull();
      // Timeouts and sandbox limits are engineering choices, not the operator's;
      // a provider's own tuning defaults the same way inside its block.
      expect(body.providers.anthropic.thinking).toBe("adaptive");
      expect(body.sandboxNetwork).toBe("allowlist");
      expect(body.hardTimeoutMs).toEqual(expect.any(Number));
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
