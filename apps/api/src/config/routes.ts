import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  loadConfig,
  loadApiKey,
  updateConfig,
  updateProvider,
  type ProviderPatch,
} from "./store.js";
import { catalogSource, fetchModels } from "../llm/catalog.js";
import { maskKey } from "../secrets.js";
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
  provider: z.enum(["anthropic", "openrouter"]).nullable().optional(),
  providers: z
    .object({
      anthropic: ProviderPatchSchema.optional(),
      openrouter: ProviderPatchSchema.optional(),
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
  provider: z.enum(["anthropic", "openrouter"]).optional(),
  baseUrl: z.string().url().optional(),
});

// The provider is explicit: a key belongs to one provider's block, and inferring
// it from whichever is active would file the key under the wrong one mid-switch.
const KeyBodySchema = z.object({
  provider: z.enum(["anthropic", "openrouter"]),
  apiKey: z.string().min(1),
});

// What listing or probing an endpoint actually needs: which dialect to speak,
// where to speak it, and (for a probe) which model to look for.
interface ProbeTarget {
  provider: LLMProviderName;
  baseUrl?: string;
  model?: string | null;
}

type TestError = "bad_key" | "unreachable" | "unknown_model";
type TestResult = { ok: true } | { ok: false; error: TestError };

async function probeEndpoint(
  target: ProbeTarget,
  apiKey: string,
): Promise<TestResult> {
  const source = catalogSource(target.provider, target.baseUrl, apiKey);
  let responseData: unknown;
  try {
    const res = await fetch(source.url, { headers: source.headers });
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

  const models = source.describe(responseData).map((m) => m.id);
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
      for (const name of ["anthropic", "openrouter"] as const) {
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

  // Proxies the catalog so the browser never calls the LLM endpoint directly:
  // the key lives in this process and must never reach the console. Each model
  // carries its own reasoning descriptor, so the form can offer exactly the
  // levels that model accepts instead of a hardcoded list.
  fastify.get("/config/models", { preHandler: requireSession }, async () => {
    const config = loadConfig();
    // Nothing to list before a provider is picked; the DB is the only key source.
    const provider = config.provider;
    if (provider === null) return { models: [] };
    const models = await fetchModels(
      provider,
      config.providers[provider].baseUrl,
      loadApiKey(provider) ?? "",
    );
    return { models };
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
