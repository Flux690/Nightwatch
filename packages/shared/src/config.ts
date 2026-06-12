// Global agent config: how the one brain reasons. Runners are hands, so this has
// no per-installation dimension (only alert-rule thresholds are per-runner). The
// API stores a single row seeded from env; secrets (API keys) stay in env and
// never appear here, so this whole shape is safe to send to the console.

export type LLMProviderName = "anthropic" | "openai";
export type ThinkingMode = "adaptive" | "off";
export type ReasoningEffort = "low" | "medium" | "high";

export interface AgentConfig {
  provider: LLMProviderName;
  model: string;
  thinking: ThinkingMode;
  maxOutputTokens: number;
  maxRetries: number;
  requestTimeoutMs: number;
  maxToolCalls: number;
  hardTimeoutMs: number;
  toolTimeoutMs: number;
  // Provider endpoint config. baseUrl overrides the SDK default; apiKeyMasked
  // is computed server-side (never stored) and shows the configured key hint.
  baseUrl?: string;
  apiKeyMasked?: string | null;
  // Provider-native tuning. promptCaching applies to Anthropic; reasoningEffort
  // applies to OpenAI-class endpoints.
  promptCaching?: boolean;
  reasoningEffort?: ReasoningEffort | null;
}
