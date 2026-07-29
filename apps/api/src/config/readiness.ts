import { loadApiKey, loadConfig } from "./store.js";
import type { ResolvedLLMConfig } from "@nightwarden/shared";

// The single answer to "can the agent reach an LLM?". Every entry point that
// starts a run asks here, so a half-configured install is refused at the door
// with a specific reason instead of failing mid-investigation as a provider error.
export type LLMReadiness =
  | { ready: true; config: ResolvedLLMConfig; apiKey: string }
  | { ready: false; missing: LLMRequirement[] };

export type LLMRequirement = "provider" | "model" | "API key";

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

  // Flatten the active block onto the loop settings the SDKs need. Each
  // provider-native knob defaults inert for the adapter it does not belong to.
  return {
    ready: true,
    apiKey,
    config: {
      provider,
      model,
      baseUrl: settings.baseUrl,
      maxOutputTokens: config.maxOutputTokens,
      maxRetries: config.maxRetries,
      requestTimeoutMs: config.requestTimeoutMs,
      thinking:
        provider === "anthropic" ? config.providers.anthropic.thinking : "off",
      reasoningEffort:
        provider === "openrouter"
          ? config.providers.openrouter.reasoningEffort
          : null,
    },
  };
}

// One wording for every surface that refuses a run, so the console banner, the
// chat route and the alert webhook all name the same missing pieces.
export function notConfiguredMessage(missing: LLMRequirement[]): string {
  return `No language model is configured: choose a ${missing.join(", ")} in console Settings before NightWarden can investigate.`;
}
