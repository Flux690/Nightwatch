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
  // When true (default), providers use native structured output (response_format
  // / output_config.format) for the final_response instead of a terminal tool
  // call. Set false to fall back to the final_response tool on endpoints that
  // do not support native structured output.
  structuredOutput?: boolean;
  maxOutputTokens: number;
  maxRetries: number;
  requestTimeoutMs: number;
  maxToolCalls: number;
  hardTimeoutMs: number;
  toolTimeoutMs: number;
}
