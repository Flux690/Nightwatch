// Global agent config: how the one brain reasons (no per-runner dimension). The API
// stores one row seeded from env; secrets stay in env, so this shape is safe to send
// to the console.

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
  hardTimeoutMs: number;
  toolTimeoutMs: number;
  // Remediation circuit breaker: at proposal time the loop refuses a write once
  // this many executed/failed writes to the same (service identity, action) have
  // landed within the window, so a crash-loop fix cannot become a restart storm.
  remediationBreakerLimit: number;
  remediationBreakerWindowMs: number;
  // Provider endpoint config. baseUrl overrides the SDK default; apiKeyMasked
  // is computed server-side (never stored) and shows the configured key hint.
  baseUrl?: string;
  apiKeyMasked?: string | null;
  // Provider-native tuning. promptCaching applies to Anthropic; reasoningEffort
  // applies to OpenAI-class endpoints.
  promptCaching?: boolean;
  reasoningEffort?: ReasoningEffort | null;
}
