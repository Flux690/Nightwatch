import "dotenv/config";
import {
  afterEach,
  beforeAll,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerConfigRoutes } from "../config/routes.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";

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
    await registerConfigRoutes(server);
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
      url: "/config/test",
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
      url: "/config/test",
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
      url: "/config/test",
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
      url: "/config/test",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { apiKey: "sk-any-key" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: "unreachable" });
  });

  // --- GET /config/models ---

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

    const res = await server.inject({ method: "GET", url: "/config/models" });

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

    const res = await server.inject({ method: "GET", url: "/config/models" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { models: string[] };
    expect(body.models).toEqual([]);
  });

  // --- Key never returned to browser ---

  it("GET /config: never returns apiKeyEncrypted or plaintext key in the response", async () => {
    const res = await server.inject({ method: "GET", url: "/config" });

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
      url: "/config/key",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { apiKey: "sk-ant-test-key-12345678" },
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
      url: "/config/key",
      headers: { cookie: `nw_auth=${SESSION}` },
      payload: { apiKey },
    });
    expect(saved.statusCode).toBe(200);

    // GET /config reads the row, decrypts, and masks - proving the encrypt →
    // store → decrypt → mask round-trip without ever returning the plaintext.
    const res = await server.inject({ method: "GET", url: "/config" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["apiKeyMasked"]).toBe("sk-...9999");
    expect(body).not.toHaveProperty("apiKeyEncrypted");
    expect(JSON.stringify(body)).not.toContain(apiKey);
  });
});
