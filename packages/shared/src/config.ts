// Global agent config: how the one brain reasons. Runners are hands, so this has
// no per-installation dimension (only alert-rule thresholds are per-runner). The
// API stores a single row seeded from env; secrets (API keys) stay in env and
// never appear here, so this whole shape is safe to send to the console.

export type LLMProviderName = "anthropic" | "openai";
export type ThinkingMode = "adaptive" | "off";

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
}
