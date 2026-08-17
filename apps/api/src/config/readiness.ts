import { loadApiKey, loadConfig } from "./store.js";
import { MAX_OUTPUT_TOKENS } from "../llm/config.js";
import type { ResolvedLLMConfig } from "@nightwarden/shared";

// The single answer to "can the agent reach an LLM?". Every entry point that
// starts a run asks here, so a half-configured install is refused at the door
// with a specific reason instead of failing mid-investigation as a provider error.
type LLMReadiness =
  | { ready: true; config: ResolvedLLMConfig; apiKey: string }
  | { ready: false; missing: LLMRequirement[] };

type LLMRequirement = "provider" | "model" | "API key";

export function checkLLMReadiness(): LLMReadiness {
  const config = loadConfig();
  const provider = config.provider;
  if (provider === null) {
    return { ready: false, missing: ["provider", "model", "API key"] };
  }

  const settings = config.providers[provider];
  const apiKey = loadApiKey(provider);
  const model = settings.model;
  const noKey = apiKey === undefined || apiKey === "";

  if (model === null || model === "" || noKey) {
    const missing: LLMRequirement[] = [];
    if (model === null || model === "") missing.push("model");
    if (noKey) missing.push("API key");
    return { ready: false, missing };
  }

  // Flatten the active block onto the loop settings the SDKs need. The output
  // ceiling is the chosen model's own, captured when it was saved; the constant
  // only stands in for a model whose catalog published none.
  return {
    ready: true,
    apiKey,
    config: {
      provider,
      model,
      baseUrl: settings.baseUrl,
      maxOutputTokens: settings.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      // No constant stands in for these two: a window we guessed would set a
      // compaction threshold the model never published.
      maxInputTokens: settings.maxInputTokens,
      compaction: settings.compaction,
      maxRetries: config.maxRetries,
      requestTimeoutMs: config.requestTimeoutMs,
      reasoningLevel: settings.reasoningLevel,
      reasoning: settings.reasoning,
    },
  };
}

// One wording for every surface that refuses a run, so the console banner, the
// chat route and the alert webhook all name the same missing pieces.
export function notConfiguredMessage(missing: LLMRequirement[]): string {
  return `No LLM is configured. NightWarden needs a ${missing.join(", ")} before it can investigate.`;
}
