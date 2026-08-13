import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  loadConfig,
  loadApiKey,
  updateConfig,
  updateProvider,
  type ProviderPatch,
} from "./store.js";
import { PROVIDER_OPTIONS, fetchCatalog, fetchModels } from "../llm/catalog.js";
import { maskKey } from "../secrets.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";

/* Zod's own message is the issues array as JSON, which the console would show
   an operator verbatim. This names the field and says what is wrong with it. */
function readable(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}
import type {
  LLMProviderName,
  ModelCatalog,
  ModelOption,
} from "@nightwarden/shared";

// One provider's settings, nested under `providers` so a change to one cannot touch
// the other's model, endpoint or credential. reasoningLevel is a free string: the
// chosen model's descriptor is the authority, not an enum here.
const ProviderPatchSchema = z.object({
  model: z.string().min(1).nullable().optional(),
  baseUrl: z.string().url().nullable().optional(),
  reasoningLevel: z.string().min(1).nullable().optional(),
});

const ConfigPatchSchema = z.object({
  provider: z.enum(["anthropic", "openrouter"]).nullable().optional(),
  providers: z
    .object({
      anthropic: ProviderPatchSchema.optional(),
      openrouter: ProviderPatchSchema.optional(),
    })
    .optional(),
  maxRetries: z.number().int().min(0).optional(),
  requestTimeoutMs: z.number().int().positive().optional(),
  maxConcurrentInvestigations: z.number().int().positive().optional(),
  checkInAfterMs: z.number().int().positive().optional(),
  toolCallCeilingMs: z.number().int().positive().optional(),
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

// The provider block being edited, not necessarily the one on disk; each field falls
// back to the stored value so a half-typed form still asks something coherent. POST
// because the key travels in the body: a credential must never reach a URL.
const CatalogBodySchema = z.object({
  provider: z.enum(["anthropic", "openrouter"]).optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
});

// The provider is explicit: a key belongs to one provider's block, and inferring
// it from whichever is active would file the key under the wrong one mid-switch.
const KeyBodySchema = z.object({
  provider: z.enum(["anthropic", "openrouter"]),
  apiKey: z.string().min(1),
});

// Picking a model captures what its catalog says about it, so starting a run
// never has to reach the network. Derived here rather than taken from the
// request: what a model supports is the provider's answer, not the browser's.
async function withModelFacts(
  provider: LLMProviderName,
  patch: ProviderPatch,
): Promise<ProviderPatch> {
  if (patch.model === undefined || patch.model === null) return patch;

  const config = loadConfig();
  const models = await fetchModels(
    provider,
    patch.baseUrl ?? config.providers[provider].baseUrl,
    loadApiKey(provider) ?? "",
  );
  const chosen = models.find((m) => m.id === patch.model);
  // An unreachable catalog leaves the facts unset rather than inventing them;
  // the readiness gate falls back to the constant ceiling.
  if (chosen === undefined) return patch;

  const level =
    patch.reasoningLevel ?? config.providers[provider].reasoningLevel;
  return {
    ...patch,
    maxOutputTokens: chosen.maxOutputTokens,
    reasoning: chosen.reasoning,
    // A level carried over from the previous model may not exist on this one,
    // so it re-resolves rather than being stored as something unsendable.
    reasoningLevel: validLevel(chosen, level),
  };
}

function validLevel(model: ModelOption, level: string | null): string | null {
  if (model.reasoning === null) return null;
  const supported = model.reasoning.levels.some((l) => l.value === level);
  return supported ? level : model.reasoning.defaultLevel;
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
        return reply.code(400).send({ error: readable(parsed.error) });
      }
      // Provider blocks are written per provider so one cannot disturb the other;
      // everything else is global and goes through the single config row.
      const { providers, ...global } = parsed.data;
      for (const name of ["anthropic", "openrouter"] as const) {
        const block = providers?.[name];
        if (block !== undefined)
          updateProvider(name, await withModelFacts(name, block));
      }
      const updated = updateConfig(global);
      logger.info(
        { keys: Object.keys(global), providers: Object.keys(providers ?? {}) },
        "agent config updated",
      );
      return updated;
    },
  );

  // Which providers this build can reach, so the picker is data rather than a
  // list the console maintains. No secrets, but gated with the rest of config.
  fastify.get("/config/providers", { preHandler: requireSession }, () => ({
    providers: PROVIDER_OPTIONS,
  }));

  // Proxied because the key lives here and must never reach the console. Answers
  // about the block being edited, not the one on disk, so listing is also what
  // verifies it: models coming back prove the endpoint and the key. Never persists.
  fastify.post(
    "/config/models",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = CatalogBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: readable(parsed.error) });
      }
      const { provider, baseUrl, apiKey } = parsed.data;

      const config = loadConfig();
      const target = provider ?? config.provider;
      // Nothing to list until a provider is chosen.
      if (target === null || target === undefined) {
        return { ok: true, models: [] } satisfies ModelCatalog;
      }
      const stored = config.providers[target];
      // A typed key wins; otherwise the saved one, so changing a model or an
      // endpoint needs no re-pasting. Whether an empty key is a problem is the
      // provider's answer, given below.
      const effectiveKey = apiKey ?? loadApiKey(target) ?? "";

      const catalog = await fetchCatalog(
        target,
        baseUrl ?? stored.baseUrl,
        effectiveKey,
      );
      logger.info(
        { provider: target, ok: catalog.ok },
        "model catalog requested",
      );
      return catalog;
    },
  );

  fastify.patch(
    "/config/key",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = KeyBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: readable(parsed.error) });
      }
      const { provider, apiKey } = parsed.data;
      updateProvider(provider, { apiKey });
      return { provider, apiKeyMasked: maskKey(apiKey) };
    },
  );
}
