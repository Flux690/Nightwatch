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
import type {
  LLMProviderName,
  ModelCatalog,
  ModelOption,
  ProviderOption,
} from "@nightwarden/shared";

// Every provider the build can reach, in the order the picker offers them. The
// console renders this rather than naming providers itself, so adding an
// adapter is a change here and nowhere in the UI.
export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    name: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: ANTHROPIC_DEFAULT_BASE_URL,
  },
  {
    name: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: OPENROUTER_DEFAULT_BASE_URL,
  },
];

// Where a catalog lives and how to read it. Each provider owns its own answer,
// so nothing here knows what a reasoning level is.
interface CatalogSource {
  url: string;
  headers: Record<string, string>;
  describe: (data: unknown) => ModelOption[];
  // Whether the provider serves its catalog to anyone. OpenRouter publishes
  // its list; Anthropic answers 401 without a key. Asking anyway would report
  // a rejected key where the truth is that none was given.
  needsKey: boolean;
}

function catalogSource(
  provider: LLMProviderName,
  baseUrl: string | undefined,
  apiKey: string,
): CatalogSource {
  if (provider === "anthropic") {
    return {
      url: `${baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL}${ANTHROPIC_MODELS_PATH}`,
      headers: anthropicAuthHeaders(apiKey),
      describe: describeAnthropicModels,
      needsKey: true,
    };
  }
  return {
    url: `${baseUrl ?? OPENROUTER_DEFAULT_BASE_URL}${OPENROUTER_MODELS_PATH}`,
    headers: openRouterAuthHeaders(apiKey),
    describe: describeOpenRouterModels,
    needsKey: false,
  };
}

// Reading the catalog is also how a provider block is verified: a list coming
// back proves the endpoint answered and, where one was needed, that the key was
// accepted.
export async function fetchCatalog(
  provider: LLMProviderName,
  baseUrl: string | undefined,
  apiKey: string,
): Promise<ModelCatalog> {
  const source = catalogSource(provider, baseUrl, apiKey);
  if (source.needsKey && apiKey === "") {
    return { ok: false, error: "needs_key" };
  }
  try {
    const res = await fetch(source.url, { headers: source.headers });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "bad_key" };
    }
    if (!res.ok) return { ok: false, error: "unreachable" };
    return { ok: true, models: source.describe(await res.json()) };
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
