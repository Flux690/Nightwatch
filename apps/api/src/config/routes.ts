import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { loadConfig, loadApiKey, updateConfig, saveApiKey } from "./store.js";
import { encrypt, maskKey } from "./crypto.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";
import type { AgentConfig } from "@nightwatch/shared";

const ConfigPatchSchema = z.object({
  provider: z.enum(["anthropic", "openai"]).optional(),
  model: z.string().min(1).optional(),
  thinking: z.enum(["adaptive", "off"]).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  hardTimeoutMs: z.number().int().positive().optional(),
  toolTimeoutMs: z.number().int().positive().optional(),
  baseUrl: z.string().url().nullable().optional(),
  promptCaching: z.boolean().optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
});

const TestBodySchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().optional(),
});

const KeyBodySchema = z.object({
  apiKey: z.string().min(1),
});

// Build the upstream model-list URL for the configured provider/baseUrl.
function modelsUrl(config: AgentConfig): string {
  if (config.provider === "anthropic") {
    const base = config.baseUrl ?? "https://api.anthropic.com";
    return `${base}/v1/models`;
  }
  const base =
    config.baseUrl ??
    process.env["OPENAI_BASE_URL"] ??
    "https://api.openai.com/v1";
  // Ollama uses /api/tags; all others use /models. baseUrl is always the full
  // versioned base (e.g. https://openrouter.ai/api/v1), so append /models only.
  if (base.endsWith("/api")) return `${base}/tags`;
  return `${base}/models`;
}

// Build auth headers appropriate for the provider.
function authHeaders(
  provider: AgentConfig["provider"],
  apiKey: string,
): Record<string, string> {
  if (provider === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

// Extract model id strings from whatever shape the upstream endpoint returns.
function extractModels(data: unknown): string[] {
  if (typeof data !== "object" || data === null) return [];
  const d = data as Record<string, unknown>;
  // Standard OpenAI / Anthropic: { data: [{ id: "..." }] }
  if (Array.isArray(d["data"])) {
    return (d["data"] as Array<Record<string, unknown>>)
      .map((m) => (typeof m["id"] === "string" ? m["id"] : null))
      .filter((id): id is string => id !== null);
  }
  // Ollama /api/tags: { models: [{ name: "..." }] }
  if (Array.isArray(d["models"])) {
    return (d["models"] as Array<Record<string, unknown>>)
      .map((m) => (typeof m["name"] === "string" ? m["name"] : null))
      .filter((id): id is string => id !== null);
  }
  return [];
}

type TestError = "bad_key" | "unreachable" | "unknown_model";
type TestResult = { ok: true } | { ok: false; error: TestError };

async function probeEndpoint(
  config: AgentConfig,
  apiKey: string,
  model?: string,
): Promise<TestResult> {
  const url = modelsUrl(config);
  const headers = authHeaders(config.provider, apiKey);
  let responseData: unknown;
  try {
    const res = await fetch(url, { headers });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "bad_key" };
    }
    if (!res.ok) {
      return { ok: false, error: "unreachable" };
    }
    responseData = await res.json();
  } catch {
    return { ok: false, error: "unreachable" };
  }

  const models = extractModels(responseData);
  const target = model ?? config.model;
  // Only flag unknown_model when the endpoint returned a non-empty list and the
  // configured model isn't in it. An empty list means the endpoint doesn't
  // support listing; treat that as a successful connection.
  if (models.length > 0 && !models.includes(target)) {
    return { ok: false, error: "unknown_model" };
  }
  return { ok: true };
}

export async function registerConfigRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // GET /config — returns AgentConfig without any encrypted/plaintext key.
  // Still gated: provider, model, baseUrl, and the masked key are not for
  // unauthenticated eyes.
  fastify.get("/config", { preHandler: requireSession }, async () => {
    const config = loadConfig();
    // apiKeyMasked is safe to return; apiKeyEncrypted never reaches here.
    return config;
  });

  fastify.patch(
    "/config",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = ConfigPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      // Zod nullable().optional() produces string | null | undefined for baseUrl;
      // destructure it out and coerce null → undefined to match AgentConfig.
      const { baseUrl: rawBaseUrl, ...rest } = parsed.data;
      const patch: Parameters<typeof updateConfig>[0] = {
        ...rest,
        ...(rawBaseUrl !== undefined && { baseUrl: rawBaseUrl ?? undefined }),
      };
      const updated = updateConfig(patch);
      logger.info({ keys: Object.keys(parsed.data) }, "agent config updated");
      return updated;
    },
  );

  // GET /config/models — proxies the configured endpoint's model list so the
  // browser never calls the LLM endpoint directly.
  fastify.get("/config/models", async () => {
    const config = loadConfig();
    const apiKey =
      loadApiKey() ??
      (config.provider === "anthropic"
        ? process.env["ANTHROPIC_API_KEY"]
        : process.env["OPENAI_API_KEY"]) ??
      "";
    const url = modelsUrl(config);
    const headers = authHeaders(config.provider, apiKey);
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return { models: [] };
      const data = await res.json();
      return { models: extractModels(data) };
    } catch {
      return { models: [] };
    }
  });

  // POST /config/test — encrypts + persists the API key, then probes the
  // configured endpoint. Returns success or a categorised error.
  fastify.post(
    "/config/test",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = TestBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const { apiKey, model } = parsed.data;

      const encrypted = encrypt(apiKey);
      saveApiKey(encrypted);

      const config = loadConfig();
      const result = await probeEndpoint(config, apiKey, model);
      logger.info({ ok: result.ok }, "config/test probe completed");
      return result;
    },
  );

  // PATCH /config/key — updates the encrypted key without touching other config
  // fields. Use POST /config/test when you also want to probe the endpoint.
  fastify.patch(
    "/config/key",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = KeyBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const { apiKey } = parsed.data;
      const encrypted = encrypt(apiKey);
      saveApiKey(encrypted);
      return { apiKeyMasked: maskKey(apiKey) };
    },
  );
}
