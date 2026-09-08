import { z } from "zod";
import type {
  CatalogError,
  LLMProviderName,
  ModelOption,
  ProviderOption,
  ReasoningDescriptor,
  ReasoningLevel,
} from "@nightwarden/shared";
import {
  capabilitiesFor,
  type ModelCapabilities,
} from "./model-capabilities.js";
import { CATALOG_TIMEOUT_MS } from "./config.js";

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// The frontend renders this rather than naming providers itself, so adding one
// is a change here and nowhere in the UI.
export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  { name: "anthropic", label: "Anthropic", defaultBaseUrl: ANTHROPIC_BASE_URL },
  { name: "openai", label: "OpenAI", defaultBaseUrl: OPENAI_BASE_URL },
  {
    name: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: OPENROUTER_BASE_URL,
  },
];

// Anthropic pages at 20 by default, which is fewer models than it publishes.
const MODELS_PATH = "/models?limit=1000";

function authHeaders(
  provider: LLMProviderName,
  apiKey: string,
): Record<string, string> {
  return provider === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${apiKey}` };
}

// All three answer with the same envelope, so one parser reads every list.
const ListSchema = z.object({
  data: z.array(z.object({ id: z.string() }).loose()),
});

/* What a provider states about its own model, in the shape each one publishes.
   Every field catches its own miss, so one surprise costs that field alone. */
const PublishedSchema = z.object({
  max_input_tokens: z.number().nullish().catch(undefined),
  max_tokens: z.number().nullish().catch(undefined),
  capabilities: z
    .object({
      context_management: z
        .object({
          compact_20260112: z
            .object({ supported: z.boolean() })
            .nullish()
            .catch(undefined),
        })
        .nullish()
        .catch(undefined),
      effort: z.record(z.string(), z.unknown()).nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
  context_length: z.number().nullish().catch(undefined),
  top_provider: z
    .object({
      max_completion_tokens: z.number().nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
  supported_parameters: z.array(z.string()).nullish().catch(undefined),
  reasoning: z
    .object({
      supported_efforts: z.array(z.string()).nullish(),
      default_effort: z.string().nullish(),
    })
    .nullish()
    .catch(undefined),
});

/* Every level any provider names, strongest first, because a ladder has holes
   and the weakest one offered is what a cheap call asks for. */
const LEVELS: readonly ReasoningLevel[] = [
  { value: "max", label: "Max" },
  { value: "xhigh", label: "Extra high" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "minimal", label: "Minimal" },
];

// Anthropic documents this as equal to omitting the parameter, and it is the
// middle of every ladder published. The strongest rung stands in without it.
const PREFERRED_DEFAULT = "high";

/* Anthropic calls it effort and the chat-completions providers call it
   reasoning; both name the same levels, so one order describes either. */
function ladderOf(
  values: readonly string[],
  stated?: string | null,
): ReasoningDescriptor | null {
  const levels = LEVELS.filter((l) => values.includes(l.value));
  if (levels.length === 0) return null;
  const defaultLevel =
    levels.find((l) => l.value === stated)?.value ??
    levels.find((l) => l.value === PREFERRED_DEFAULT)?.value ??
    levels[0]?.value ??
    PREFERRED_DEFAULT;
  return { levels: [...levels], defaultLevel };
}

/* Only named levels are read. A toggle is an off switch, and thinking stays on;
   a token budget says the same thing in a unit the settings form cannot show. */
function snapshotLevels(model: ModelCapabilities): string[] {
  return (
    model.reasoning_options?.find((o) => o.type === "effort")?.values ?? []
  );
}

// Anthropic names each level as its own object, and `supported` is the group's
// own flag rather than a level.
function statedLevels(
  effort: Record<string, unknown> | null | undefined,
): string[] {
  if (!effort) return [];
  return Object.entries(effort).flatMap(([level, value]) =>
    level !== "supported" &&
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["supported"] === true
      ? [level]
      : [],
  );
}

// Everything a run needs about one model; the wire form carries a subset.
export interface CatalogModel extends ModelOption {
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  compaction: boolean;
}

// Keeps the limits the wire form drops, so a run resolves from the same answer
// the settings form was drawn from.
export type ProviderCatalog =
  { ok: true; models: CatalogModel[] } | { ok: false; error: CatalogError };

/* The provider is the source for every field it publishes and the models.dev
   snapshot answers the rest, merged field by field rather than all or nothing. */
async function describe(
  provider: LLMProviderName,
  entries: Array<Record<string, unknown> & { id: string }>,
): Promise<CatalogModel[]> {
  const capabilities = await capabilitiesFor(provider);
  return entries.flatMap((entry): CatalogModel[] => {
    const known = capabilities.get(entry.id);
    const said = PublishedSchema.safeParse(entry);
    const own = said.success ? said.data : null;
    const params = own?.supported_parameters;
    // A model that cannot call a tool cannot run the loop.
    if ((params ? params.includes("tools") : known?.tool_call) === false) {
      return [];
    }
    // Whichever word the provider uses for the same ladder.
    const stated =
      own?.reasoning?.supported_efforts ??
      statedLevels(own?.capabilities?.effort);
    const levels =
      stated.length > 0
        ? stated
        : known === undefined
          ? []
          : snapshotLevels(known);
    return [
      {
        id: entry.id,
        reasoning: ladderOf(levels, own?.reasoning?.default_effort),
        maxInputTokens:
          own?.max_input_tokens ??
          own?.context_length ??
          known?.limit?.context ??
          null,
        maxOutputTokens:
          own?.max_tokens ??
          own?.top_provider?.max_completion_tokens ??
          known?.limit?.output ??
          null,
        // OpenAI publishes no flag and offers it on its reasoning models;
        // OpenRouter drops turns from the middle instead of summarising.
        compaction:
          own?.capabilities?.context_management?.compact_20260112?.supported ===
            true ||
          (provider === "openai" && known?.reasoning === true),
      },
    ];
  });
}

/* A list coming back proves the endpoint answered, and on a provider that
   requires a key to list, that the key was accepted. OpenRouter's list is public. */
export async function fetchCatalog(
  provider: LLMProviderName,
  baseUrl: string | undefined,
  apiKey: string,
): Promise<ProviderCatalog> {
  const url = `${baseUrl ?? PROVIDER_OPTIONS.find((p) => p.name === provider)?.defaultBaseUrl ?? ""}${MODELS_PATH}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      headers: authHeaders(provider, apiKey),
    });
    // The response decides which of the two credential faults it is: nothing
    // here has to know whether this provider publishes its list unauthenticated.
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: apiKey === "" ? "needs_key" : "bad_key" };
    }
    if (!res.ok) return { ok: false, error: "unreachable" };
    const parsed = ListSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, error: "unreachable" };
    return { ok: true, models: await describe(provider, parsed.data.data) };
  } catch {
    return { ok: false, error: "unreachable" };
  }
}

// The settings form draws controls, so it is sent what it draws.
export function offeredModels(models: readonly CatalogModel[]): ModelOption[] {
  return models.map(({ id, reasoning }) => ({ id, reasoning }));
}

const CATALOG_TTL_MS = 60 * 60_000;

const held = new Map<
  LLMProviderName,
  { models: CatalogModel[]; until: number }
>();

// Test seams: the cache is process-wide, so a suite has to be able to clear it
// and to fill it rather than reach a provider from every run it starts.
export function forgetCatalog(): void {
  held.clear();
}

export function seedCatalog(
  provider: LLMProviderName,
  models: CatalogModel[],
): void {
  held.set(provider, { models, until: Date.now() + CATALOG_TTL_MS });
}

/* What a run reads. A provider it cannot reach leaves the last answer standing,
   since a model's limits do not change because the network did. */
export async function catalogFor(
  provider: LLMProviderName,
  baseUrl: string | undefined,
  apiKey: string,
): Promise<CatalogModel[]> {
  const cached = held.get(provider);
  if (cached && Date.now() < cached.until) return cached.models;
  const catalog = await fetchCatalog(provider, baseUrl, apiKey);
  if (!catalog.ok) return cached?.models ?? [];
  held.set(provider, {
    models: catalog.models,
    until: Date.now() + CATALOG_TTL_MS,
  });
  return catalog.models;
}
