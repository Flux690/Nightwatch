import { z } from "zod";
import type {
  LLMProviderName,
  ModelCatalog,
  ModelOption,
  ProviderOption,
  ReasoningLevel,
} from "@nightwarden/shared";
import {
  capabilitiesFor,
  type ModelCapabilities,
} from "./model-capabilities.js";

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

/* Strongest first, because a ladder has holes and the weakest rung offered is
   what a cheap one-shot call asks for. "none" never appears: thinking stays on. */
const LADDER: readonly ReasoningLevel[] = [
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

/* Only an effort ladder is read. A toggle is an off switch, and a token budget
   is a second way to say the same thing in a unit the settings form cannot show. */
function reasoningOf(model: ModelCapabilities): ModelOption["reasoning"] {
  const values = model.reasoning_options?.find(
    (o) => o.type === "effort",
  )?.values;
  if (values === undefined) return null;
  const levels = LADDER.filter((l) => values.includes(l.value));
  if (levels.length === 0) return null;
  const defaultLevel =
    levels.find((l) => l.value === PREFERRED_DEFAULT)?.value ??
    levels[0]?.value ??
    PREFERRED_DEFAULT;
  return { levels: [...levels], defaultLevel };
}

/* Anthropic states it per model; OpenAI offers it on its reasoning models and
   publishes no flag; OpenRouter drops turns from the middle instead. */
function compactionOf(
  provider: LLMProviderName,
  entry: Record<string, unknown>,
  known: ModelCapabilities | undefined,
): boolean {
  if (provider === "anthropic") return statesCompaction(entry);
  return provider === "openai" && known?.reasoning === true;
}

// Nested three deep and nullable at every hop, so absence anywhere reads as
// "cannot compact" rather than as a shape to assume.
function statesCompaction(entry: Record<string, unknown>): boolean {
  const capabilities = entry["capabilities"];
  if (typeof capabilities !== "object" || capabilities === null) return false;
  const management = (capabilities as Record<string, unknown>)[
    "context_management"
  ];
  if (typeof management !== "object" || management === null) return false;
  const compact = (management as Record<string, unknown>)["compact_20260112"];
  return (
    typeof compact === "object" &&
    compact !== null &&
    (compact as Record<string, unknown>)["supported"] === true
  );
}

/* The live list says which ids exist and that the key was accepted; the snapshot
   says what each one can do. An id the snapshot has not met is still offered. */
async function describe(
  provider: LLMProviderName,
  entries: Array<Record<string, unknown> & { id: string }>,
): Promise<ModelOption[]> {
  const capabilities = await capabilitiesFor(provider);
  return entries.flatMap((entry): ModelOption[] => {
    const known = capabilities.get(entry.id);
    // A model that cannot call a tool cannot run the loop.
    if (known?.tool_call === false) return [];
    return [
      {
        id: entry.id,
        reasoning: known === undefined ? null : reasoningOf(known),
        maxOutputTokens: known?.limit?.output ?? null,
        maxInputTokens: known?.limit?.context ?? null,
        compaction: compactionOf(provider, entry, known),
      },
    ];
  });
}

/* Reading the catalogue is also how a provider block is verified: a list coming
   back proves the endpoint answered and that the key was accepted. */
export async function fetchCatalog(
  provider: LLMProviderName,
  baseUrl: string | undefined,
  apiKey: string,
): Promise<ModelCatalog> {
  const url = `${baseUrl ?? PROVIDER_OPTIONS.find((p) => p.name === provider)?.defaultBaseUrl ?? ""}${MODELS_PATH}`;
  try {
    const res = await fetch(url, { headers: authHeaders(provider, apiKey) });
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

// For callers that only want the list and treat any failure as "nothing known".
export async function fetchModels(
  provider: LLMProviderName,
  baseUrl: string | undefined,
  apiKey: string,
): Promise<ModelOption[]> {
  const catalog = await fetchCatalog(provider, baseUrl, apiKey);
  return catalog.ok ? catalog.models : [];
}
