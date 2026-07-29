import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_MODELS_PATH,
  anthropicAuthHeaders,
  describeAnthropicModels,
} from "./anthropic.js";
import {
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_MODELS_PATH,
  describeOpenRouterModels,
  openRouterAuthHeaders,
} from "./openrouter.js";
import type { LLMProviderName, ModelOption } from "@nightwarden/shared";

// Where a catalog lives and how to read it. Each provider owns its own answer,
// so nothing here knows what a reasoning level is.
interface CatalogSource {
  url: string;
  headers: Record<string, string>;
  describe: (data: unknown) => ModelOption[];
}

export function catalogSource(
  provider: LLMProviderName,
  baseUrl: string | undefined,
  apiKey: string,
): CatalogSource {
  if (provider === "anthropic") {
    return {
      url: `${baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL}${ANTHROPIC_MODELS_PATH}`,
      headers: anthropicAuthHeaders(apiKey),
      describe: describeAnthropicModels,
    };
  }
  return {
    url: `${baseUrl ?? OPENROUTER_DEFAULT_BASE_URL}${OPENROUTER_MODELS_PATH}`,
    headers: openRouterAuthHeaders(apiKey),
    describe: describeOpenRouterModels,
  };
}

// An unreachable or unreadable catalog yields an empty list rather than an
// error: the operator can still type a model id, and the settings form stays
// usable when the provider is having a bad day.
export async function fetchModels(
  provider: LLMProviderName,
  baseUrl: string | undefined,
  apiKey: string,
): Promise<ModelOption[]> {
  const source = catalogSource(provider, baseUrl, apiKey);
  try {
    const res = await fetch(source.url, { headers: source.headers });
    if (!res.ok) return [];
    return source.describe(await res.json());
  } catch {
    return [];
  }
}
