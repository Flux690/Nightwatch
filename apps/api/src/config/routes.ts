import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  loadConfig,
  loadApiKey,
  updateConfig,
  updateProvider,
  type ProviderPatch,
} from "./store.js";
import { maskKey } from "./crypto.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";
import type { LLMProviderName } from "@nightwarden/shared";

// One provider's settings. Nested under `providers` on the patch so a change to
// one cannot touch the other's model, endpoint, or credential.
const ProviderPatchSchema = z.object({
  model: z.string().min(1).nullable().optional(),
  baseUrl: z.string().url().nullable().optional(),
  thinking: z.enum(["adaptive", "off"]).optional(),
  reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(),
});

const ConfigPatchSchema = z.object({
  provider: z.enum(["anthropic", "openai"]).nullable().optional(),
  providers: z
    .object({
      anthropic: ProviderPatchSchema.optional(),
      openai: ProviderPatchSchema.optional(),
    })
    .optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  hardTimeoutMs: z.number().int().positive().optional(),
  toolTimeoutMs: z.number().int().positive().optional(),
  remediationBreakerLimit: z.number().int().positive().optional(),
  remediationBreakerWindowMs: z.number().int().positive().optional(),
  codeSessionBudgetMs: z.number().int().positive().optional(),
  sandboxIdleTimeoutMs: z.number().int().positive().optional(),
  sandboxCpus: z.number().int().positive().optional(),
  sandboxMemoryMb: z.number().int().positive().optional(),
  sandboxRequireGvisor: z.boolean().optional(),
  sandboxNetwork: z.enum(["allowlist", "open", "none"]).optional(),
  sandboxAllowlistHosts: z
    .array(
      z
        .string()
        .regex(
          /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
          "hostnames only, e.g. registry.npmjs.org",
        ),
    )
    .min(1)
    .optional(),
});

const TestBodySchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().optional(),
  provider: z.enum(["anthropic", "openai"]).optional(),
  baseUrl: z.string().url().optional(),
});

// The provider is explicit: a key belongs to one provider's block, and inferring
// it from whichever is active would file the key under the wrong one mid-switch.
const KeyBodySchema = z.object({
  provider: z.enum(["anthropic", "openai"]),
  apiKey: z.string().min(1),
});

// What listing or probing an endpoint actually needs: which dialect to speak,
// where to speak it, and (for a probe) which model to look for.
interface ProbeTarget {
  provider: LLMProviderName;
  baseUrl?: string;
  model?: string | null;
}

function modelsUrl(target: ProbeTarget): string {
  if (target.provider === "anthropic") {
    const base = target.baseUrl ?? "https://api.anthropic.com";
    return `${base}/v1/models`;
  }
  const base = target.baseUrl ?? "https://api.openai.com/v1";
  // Ollama uses /api/tags; all others use /models. baseUrl is always the full
  // versioned base (e.g. https://openrouter.ai/api/v1), so append /models only.
  if (base.endsWith("/api")) return `${base}/tags`;
  return `${base}/models`;
}

function authHeaders(
  provider: LLMProviderName,
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
  target: ProbeTarget,
  apiKey: string,
): Promise<TestResult> {
  const url = modelsUrl(target);
  const headers = authHeaders(target.provider, apiKey);
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
  // Only flag unknown_model against a non-empty list; an empty list means the
  // endpoint doesn't support listing, so treat that as a successful connection.
  // An unset model means the form is testing a key before picking one.
  const wanted = target.model;
  if (wanted && models.length > 0 && !models.includes(wanted)) {
    return { ok: false, error: "unknown_model" };
  }
  return { ok: true };
}

export async function registerConfigRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // gated: config includes provider/model/baseUrl — not for unauthenticated eyes
  fastify.get("/config", { preHandler: requireSession }, async () => {
    const config = loadConfig();
    // apiKeyMasked is safe to return; apiKeyEncrypted never reaches here
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
      // Provider blocks are written per provider so one cannot disturb the other;
      // everything else is global and goes through the single config row.
      const { providers, ...global } = parsed.data;
      for (const name of ["anthropic", "openai"] as const) {
        const block = providers?.[name];
        if (block !== undefined)
          updateProvider(name, block satisfies ProviderPatch);
      }
      const updated = updateConfig(global);
      logger.info(
        { keys: Object.keys(global), providers: Object.keys(providers ?? {}) },
        "agent config updated",
      );
      return updated;
    },
  );

  // proxies model list so the browser never calls the LLM endpoint directly
  fastify.get("/config/models", { preHandler: requireSession }, async () => {
    const config = loadConfig();
    // Nothing to list before a provider is picked; the DB is the only key source.
    const provider = config.provider;
    if (provider === null) return { models: [] };
    const apiKey = loadApiKey(provider) ?? "";
    const url = modelsUrl({
      provider,
      baseUrl: config.providers[provider].baseUrl,
    });
    const headers = authHeaders(provider, apiKey);
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return { models: [] };
      const data = await res.json();
      return { models: extractModels(data) };
    } catch {
      return { models: [] };
    }
  });

  // Tests only - never persists. Provider/baseUrl overrides let the caller
  // probe against unsaved form edits instead of whatever is on disk.
  fastify.post(
    "/config/test",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = TestBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const { apiKey, model, provider, baseUrl } = parsed.data;

      // Falls back to the stored block only for what the form did not override,
      // so a probe can test an unsaved provider/endpoint/model combination.
      const config = loadConfig();
      const target: ProbeTarget = {
        provider: provider ?? config.provider ?? "anthropic",
        baseUrl,
        model,
      };
      if (baseUrl === undefined && provider === undefined && config.provider) {
        target.baseUrl = config.providers[config.provider].baseUrl;
      }
      const result = await probeEndpoint(target, apiKey);
      logger.info({ ok: result.ok }, "config/test probe completed");
      return result;
    },
  );

  fastify.patch(
    "/config/key",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = KeyBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      const { provider, apiKey } = parsed.data;
      updateProvider(provider, { apiKey });
      return { provider, apiKeyMasked: maskKey(apiKey) };
    },
  );
}
