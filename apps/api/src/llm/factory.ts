import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type {
  LanguageModelV4,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import type { LLMProviderName, ResolvedLLMConfig } from "@nightwarden/shared";
import {
  ANTHROPIC_BASE_URL,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
} from "./catalog.js";
import { SdkProvider } from "./provider.js";
import type { LLMProvider, ProviderCallOptions } from "./types.js";

function languageModel(
  config: ResolvedLLMConfig,
  apiKey?: string,
): LanguageModelV4 {
  const settings = {
    ...(apiKey !== undefined && { apiKey }),
    baseURL: config.baseUrl ?? defaultBaseUrl(config.provider),
  };
  switch (config.provider) {
    case "anthropic":
      return createAnthropic(settings)(config.model);
    case "openai":
      return createOpenAI(settings).responses(config.model);
    case "openrouter":
      return createOpenRouter(settings).chat(config.model);
  }
}

function defaultBaseUrl(provider: LLMProviderName): string {
  if (provider === "anthropic") return ANTHROPIC_BASE_URL;
  return provider === "openai" ? OPENAI_BASE_URL : OPENROUTER_BASE_URL;
}

/* The rung to ask for. Reasoning is never switched off: a model told not to
   reason writes its tool calls as prose instead of calling them. */
function effort(
  config: ResolvedLLMConfig,
  opts?: ProviderCallOptions,
): string | null {
  const levels = config.reasoning?.levels ?? [];
  // Ordered strongest to weakest, so the last rung is the cheapest offered.
  return opts?.minimalReasoning
    ? (levels[levels.length - 1]?.value ?? null)
    : config.reasoningLevel;
}

// The only place a provider is named for what a request carries. Each level came
// from that provider's own catalogue, so it passes through unmapped.
export function requestOptions(
  config: ResolvedLLMConfig,
  opts?: ProviderCallOptions,
): SharedV4ProviderOptions {
  const level = effort(config, opts);
  switch (config.provider) {
    case "anthropic":
      return {
        anthropic: {
          thinking: { type: "adaptive", display: "summarized" },
          ...(level !== null && { effort: level }),
          // No trigger: Anthropic's own default decides when, and a number of
          // ours would be a guess dressed as a setting.
          ...(config.compaction && {
            contextManagement: { edits: [{ type: "compact_20260112" }] },
          }),
        },
      };
    case "openai": {
      const threshold = compactThreshold(config);
      return {
        openai: {
          ...(level !== null && { reasoningEffort: level }),
          ...(threshold !== null && {
            contextManagement: [
              { type: "compaction", compactThreshold: threshold },
            ],
          }),
        },
      };
    }
    case "openrouter":
      return level === null
        ? {}
        : { openrouter: { reasoning: { effort: level } } };
  }
}

/* OpenAI requires a threshold, so it gets the highest one that can ever fire:
   the reply is reserved out of the window, so input can never reach the whole of it. */
function compactThreshold(config: ResolvedLLMConfig): number | null {
  const window = config.maxInputTokens;
  if (!config.compaction || window === null) return null;
  const reachable = window - config.maxOutputTokens;
  return reachable > 0 ? reachable : null;
}

// Taking a ResolvedLLMConfig means an unconfigured install cannot reach here:
// the readiness gate is the only way to obtain one.
export function createProvider(
  system: string,
  config: ResolvedLLMConfig,
  apiKey?: string,
  opts?: ProviderCallOptions,
): LLMProvider {
  return new SdkProvider(languageModel(config, apiKey), system, {
    maxOutputTokens: config.maxOutputTokens,
    providerOptions: requestOptions(config, opts),
  });
}

// Named apart from createProvider so a test can mock the one-shot title call on
// its own, leaving title generation a harmless no-op when it does not.
export function createTitleProvider(
  system: string,
  config: ResolvedLLMConfig,
  apiKey?: string,
  opts?: ProviderCallOptions,
): LLMProvider {
  return createProvider(system, config, apiKey, opts);
}
