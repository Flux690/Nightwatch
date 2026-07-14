import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import type { Provider } from "./provider.js";
import type { ProviderCallOptions } from "./types.js";
import type { AgentConfig } from "@nightwatch/shared";

// Both adapters are always compiled in; the global config picks one at runtime. apiKey, when
// supplied, overrides each provider's env-var fallback so the DB-stored key takes precedence.
export function createProvider(
  system: string,
  config: AgentConfig,
  apiKey?: string,
  opts?: ProviderCallOptions,
): Provider {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(system, config, apiKey, opts);
    case "openai":
      return new OpenAIProvider(system, config, apiKey, opts);
    default:
      throw new Error(
        `Unknown provider "${config.provider}" (expected "anthropic" or "openai")`,
      );
  }
}

// Same provider as createProvider, named distinctly so tests can mock the
// one-shot title call independently; a test that stubs only createProvider
// leaves title generation a harmless no-op.
export function createTitleProvider(
  system: string,
  config: AgentConfig,
  apiKey?: string,
  opts?: ProviderCallOptions,
): Provider {
  return createProvider(system, config, apiKey, opts);
}
