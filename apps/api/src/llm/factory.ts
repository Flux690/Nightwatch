import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import type { Provider } from "./provider.js";
import type { AgentConfig } from "@nightwatch/shared";

// Both adapters are always compiled in; the global config picks one at runtime.
// apiKey, when supplied, overrides the env-var fallback in each provider so the
// DB-stored encrypted key (decrypted by the caller) takes precedence.
export function createProvider(
  system: string,
  config: AgentConfig,
  apiKey?: string,
): Provider {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(system, config, apiKey);
    case "openai":
      return new OpenAIProvider(system, config, apiKey);
    default:
      throw new Error(
        `Unknown provider "${config.provider}" (expected "anthropic" or "openai")`,
      );
  }
}
