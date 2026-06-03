import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import type { LLMProvider } from "./types.js";

// Both adapters are always compiled in; LLM_PROVIDER picks one at runtime.
export function createProvider(system: string): LLMProvider {
  const provider = process.env["LLM_PROVIDER"] ?? "anthropic";
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(system);
    case "openai":
      return new OpenAIProvider(system);
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${provider}" (expected "anthropic" or "openai")`,
      );
  }
}
