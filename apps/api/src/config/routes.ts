import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  loadConfig,
  loadApiKey,
  updateConfig,
  updateProvider,
  type ProviderPatch,
} from "./store.js";
import {
  PROVIDER_OPTIONS,
  catalogFor,
  fetchCatalog,
  offeredModels,
} from "../llm/catalog.js";
import { maskKey } from "../secrets.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";

import { readable } from "../request-body.js";
import type {
  LLMProviderName,
  ModelCatalog,
  ModelOption,
} from "@nightwarden/shared";

/* Every name this build serves, so no second list is kept. Asserted to a
   non-empty tuple, which is the only shape z.enum takes. */
const PROVIDER_NAME = z.enum(
  PROVIDER_OPTIONS.map((p) => p.name) as [
    LLMProviderName,
    ...LLMProviderName[],
  ],
);

// Nested under `providers` so a change to one cannot touch the other's model,
// endpoint or credential. reasoningLevel is free: the descriptor is authority.
const ProviderPatchSchema = z.object({
  model: z.string().min(1).nullable().optional(),
  baseUrl: z.string().url().nullable().optional(),
  reasoningLevel: z.string().min(1).nullable().optional(),
});

const ConfigPatchSchema = z.object({
  provider: PROVIDER_NAME.nullable().optional(),
  providers: z
    .object({
      anthropic: ProviderPatchSchema.optional(),
      openai: ProviderPatchSchema.optional(),
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

// Each field falls back to the stored value, so a half-typed form still asks
// something coherent. POST because a credential must never reach a URL.
const CatalogBodySchema = z.object({
  provider: PROVIDER_NAME.optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
});

// The provider is explicit: a key belongs to one provider's block, and inferring
// it from whichever is active would file the key under the wrong one mid-switch.
const KeyBodySchema = z.object({
  provider: PROVIDER_NAME,
  apiKey: z.string().min(1),
});

/* The only thing worth settling at pick time: a level carried over from the
   previous model may not exist on this one, so it re-resolves before it is stored. */
async function withValidLevel(
  provider: LLMProviderName,
  patch: ProviderPatch,
): Promise<ProviderPatch> {
  if (patch.model === undefined || patch.model === null) return patch;

  const config = await loadConfig();
  const models = await catalogFor(
    provider,
    patch.baseUrl ?? config.providers[provider].baseUrl,
    (await loadApiKey(provider)) ?? "",
  );
  const chosen = models.find((m) => m.id === patch.model);
  if (chosen === undefined) return patch;

  const level =
    patch.reasoningLevel ?? config.providers[provider].reasoningLevel;
  return { ...patch, reasoningLevel: validLevel(chosen, level) };
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
    const config = await loadConfig();
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
      for (const name of PROVIDER_OPTIONS.map((p) => p.name)) {
        const block = providers?.[name];
        if (block !== undefined)
          await updateProvider(name, await withValidLevel(name, block));
      }
      const updated = await updateConfig(global);
      logger.info(
        { keys: Object.keys(global), providers: Object.keys(providers ?? {}) },
        "agent config updated",
      );
      return updated;
    },
  );

  // Proxied because the key lives here and must never reach the frontend.
  // Listing verifies too: models coming back prove the endpoint and the key.
  fastify.post(
    "/config/models",
    { preHandler: requireSession },
    async (request, reply) => {
      const parsed = CatalogBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: readable(parsed.error) });
      }
      const { provider, baseUrl, apiKey } = parsed.data;

      const config = await loadConfig();
      const target = provider ?? config.provider;
      // Nothing to list until a provider is chosen.
      if (target === null || target === undefined) {
        return { ok: true, models: [] } satisfies ModelCatalog;
      }
      const stored = config.providers[target];
      // A typed key wins, otherwise the saved one, so changing a model or an
      // endpoint needs no re-pasting.
      const effectiveKey = apiKey ?? (await loadApiKey(target)) ?? "";

      const catalog = await fetchCatalog(
        target,
        baseUrl ?? stored.baseUrl,
        effectiveKey,
      );
      logger.info(
        { provider: target, ok: catalog.ok },
        "model catalog requested",
      );
      return catalog.ok
        ? ({
            ok: true,
            models: offeredModels(catalog.models),
          } satisfies ModelCatalog)
        : catalog;
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
      await updateProvider(provider, { apiKey });
      return { provider, apiKeyMasked: maskKey(apiKey) };
    },
  );
}
