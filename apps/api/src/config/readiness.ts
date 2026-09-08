import { loadApiKey, loadConfig } from "./store.js";
import { MAX_OUTPUT_TOKENS } from "../llm/config.js";
import { catalogFor } from "../llm/catalog.js";
import type { ResolvedLLMConfig } from "@nightwarden/shared";

// Every entry point that starts a run asks here, so a half-configured install
// is refused at the door rather than mid-investigation.
type LLMReadiness =
  | { ready: true; config: ResolvedLLMConfig; apiKey: string }
  | { ready: false; missing: LLMRequirement[] };

type LLMRequirement = "provider" | "model" | "API key";

export async function checkLLMReadiness(): Promise<LLMReadiness> {
  const config = await loadConfig();
  const provider = config.provider;
  if (provider === null) {
    return { ready: false, missing: ["provider", "model", "API key"] };
  }

  const settings = config.providers[provider];
  const apiKey = await loadApiKey(provider);
  const model = settings.model;
  const noKey = apiKey === undefined || apiKey === "";

  if (model === null || model === "" || noKey) {
    const missing: LLMRequirement[] = [];
    if (model === null || model === "") missing.push("model");
    if (noKey) missing.push("API key");
    return { ready: false, missing };
  }

  // Read rather than stored, so a model that gains a window or a capability is
  // described as it is published today.
  const described = (await catalogFor(provider, settings.baseUrl, apiKey)).find(
    (entry) => entry.id === model,
  );

  return {
    ready: true,
    apiKey,
    config: {
      provider,
      model,
      baseUrl: settings.baseUrl,
      // The constant stands in only where the catalog publishes no ceiling.
      maxOutputTokens: described?.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      // No constant stands in for these two: a window we guessed would set a
      // compaction threshold the model never published.
      maxInputTokens: described?.maxInputTokens ?? null,
      compaction: described?.compaction ?? false,
      maxRetries: config.maxRetries,
      requestTimeoutMs: config.requestTimeoutMs,
      reasoningLevel: settings.reasoningLevel,
      reasoning: described?.reasoning ?? null,
    },
  };
}

// One wording for every surface that refuses a run, so the frontend banner, the
// chat route and the alert webhook all name the same missing pieces.
export function notConfiguredMessage(missing: LLMRequirement[]): string {
  return `No LLM is configured. NightWarden needs a ${missing.join(", ")} before it can investigate.`;
}
