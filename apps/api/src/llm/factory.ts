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

// A ratio rather than a count, so it cannot drift per model: on a 200k window it
// reproduces Anthropic's own documented default of 150,000 exactly.
const COMPACTION_TRIGGER_RATIO = 0.75;

// Anthropic refuses a lower trigger, so a window too small for the ratio to
// clear it compacts at the floor instead of sending a value that would 400.
const MIN_COMPACTION_TRIGGER = 50_000;

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
  const trigger = compactionTrigger(config);
  switch (config.provider) {
    case "anthropic":
      return {
        anthropic: {
          thinking: { type: "adaptive", display: "summarized" },
          ...(level !== null && { effort: level }),
          ...(trigger !== null && {
            contextManagement: {
              edits: [
                {
                  type: "compact_20260112",
                  trigger: { type: "input_tokens", value: trigger },
                },
              ],
            },
          }),
        },
      };
    case "openai":
      return {
        openai: {
          ...(level !== null && { reasoningEffort: level }),
          ...(trigger !== null && {
            contextManagement: [
              { type: "compaction", compactThreshold: trigger },
            ],
          }),
        },
      };
    case "openrouter":
      return level === null
        ? {}
        : { openrouter: { reasoning: { effort: level } } };
  }
}

/* Both facts come from the catalogue, so a model that stated neither is sent
   nothing and the run ends on the provider's own refusal instead. */
function compactionTrigger(config: ResolvedLLMConfig): number | null {
  const window = config.maxInputTokens;
  if (!config.compaction || window === null) return null;
  return Math.max(
    MIN_COMPACTION_TRIGGER,
    Math.round(window * COMPACTION_TRIGGER_RATIO),
  );
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
