// Global agent config: how the one brain reasons (no per-runner dimension). Every
// value here is API-seeded and safe to send to the console; keys are masked.

export type LLMProviderName = "anthropic" | "openrouter";
export type ThinkingMode = "adaptive" | "off";
export type ReasoningEffort = "low" | "medium" | "high";
// "allowlist" routes all sandbox egress through an enforcing proxy that only
// reaches approved hosts; "none" gives no network at all; "open" is unrestricted.
export type SandboxNetwork = "allowlist" | "open" | "none";

// How to reach one provider. Each keeps its own credentials, so switching the
// active provider cannot carry the previous one's key or endpoint across.
export interface ProviderSettings {
  model: string | null;
  // Unset means the provider's own endpoint. Set it to reach a gateway or a
  // self-hosted deployment of the same API.
  baseUrl?: string;
  // Computed server-side on read and never stored; the plaintext never leaves.
  apiKeyMasked?: string | null;
}

export interface AnthropicSettings extends ProviderSettings {
  thinking: ThinkingMode;
}

export interface OpenRouterSettings extends ProviderSettings {
  reasoningEffort: ReasoningEffort | null;
}

export interface ProviderSettingsMap {
  anthropic: AnthropicSettings;
  openrouter: OpenRouterSettings;
}

export interface AgentConfig {
  // Which provider block is live; null until an operator picks one. There is no
  // default: a fresh install must not look configured when it can reach no LLM.
  provider: LLMProviderName | null;
  providers: ProviderSettingsMap;
  maxOutputTokens: number;
  maxRetries: number;
  requestTimeoutMs: number;
  hardTimeoutMs: number;
  toolTimeoutMs: number;
  // Remediation circuit breaker: refuses a write once this many executed/failed writes to
  // the same (service identity, action) landed within the window, so a crash-loop fix cannot become a restart storm.
  remediationBreakerLimit: number;
  remediationBreakerWindowMs: number;
  // Code sessions: any repo tool call re-extends the session deadline to
  // codeSessionBudgetMs; the sandbox knobs bound the per-session container.
  codeSessionBudgetMs: number;
  sandboxIdleTimeoutMs: number;
  sandboxCpus: number;
  sandboxMemoryMb: number;
  // Fail-loud: refuses to start unless the Docker host has gVisor (runsc).
  // Off by default, gVisor is used automatically wherever present.
  sandboxRequireGvisor: boolean;
  sandboxNetwork: SandboxNetwork;
  // Domains the allowlist proxy may reach, one hostname per entry.
  sandboxAllowlistHosts: string[];
}

// The active provider's block flattened onto the loop settings an SDK call needs.
// Only the readiness gate builds one, so holding it is proof the install is
// configured and no call site has to re-check.
export interface ResolvedLLMConfig {
  provider: LLMProviderName;
  model: string;
  baseUrl?: string;
  maxOutputTokens: number;
  maxRetries: number;
  requestTimeoutMs: number;
  // Provider-native tuning: thinking is Anthropic's, reasoningEffort is
  // OpenRouter's. Each is inert for the other adapter.
  thinking: ThinkingMode;
  reasoningEffort: ReasoningEffort | null;
}

// A setup problem the console surfaces app-wide (a banner), computed server-side
// from the config, fleet, integrations, and observed metric labels. Mostly advisory,
// but llm-not-configured is also enforced: without a model nothing can run at all.
export type ConfigHealthKind =
  | "llm-not-configured"
  | "no-evidence-source"
  | "missing-server-label"
  | "unknown-server-label";

export interface ConfigHealthIssue {
  kind: ConfigHealthKind;
  message: string;
  // Console route the banner's action links to.
  href: string;
}

export interface ConfigHealth {
  issues: ConfigHealthIssue[];
}
