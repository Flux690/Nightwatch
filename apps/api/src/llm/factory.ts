import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";
import type { AgentConfig } from "@nightwatch/shared";

// Both adapters are always compiled in; the global config picks one at runtime.
export function createProvider(
  system: string,
  config: AgentConfig,
): LLMProvider {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicProvider(system, config);
    case "openai":
      return new OpenAIProvider(system, config);
    default:
      throw new Error(
        `Unknown provider "${config.provider}" (expected "anthropic" or "openai")`,
      );
  }
}
