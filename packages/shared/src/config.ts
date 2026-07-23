// Global agent config: how the one brain reasons (no per-runner dimension). Secrets
// stay in env, so this API-seeded shape is safe to send to the console.

export type LLMProviderName = "anthropic" | "openai";
export type ThinkingMode = "adaptive" | "off";
export type ReasoningEffort = "low" | "medium" | "high";
// "allowlist" routes all sandbox egress through an enforcing proxy that only
// reaches approved hosts; "none" gives no network at all; "open" is unrestricted.
export type SandboxNetwork = "allowlist" | "open" | "none";

export interface AgentConfig {
  provider: LLMProviderName;
  model: string;
  thinking: ThinkingMode;
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
  // Provider endpoint config. baseUrl overrides the SDK default; apiKeyMasked
  // is computed server-side (never stored) and shows the configured key hint.
  baseUrl?: string;
  apiKeyMasked?: string | null;
  // Provider-native tuning. promptCaching applies to Anthropic; reasoningEffort
  // applies to OpenAI-class endpoints.
  promptCaching?: boolean;
  reasoningEffort?: ReasoningEffort | null;
}

// A setup problem the console surfaces app-wide (a banner), computed server-side
// from the fleet, integrations, and observed metric labels. Advisory: investigations
// still run; the banner exists to make a misconfiguration visible at setup, not at 3am.
export type ConfigHealthKind =
  "no-evidence-source" | "missing-server-label" | "unknown-server-label";

export interface ConfigHealthIssue {
  kind: ConfigHealthKind;
  message: string;
  // Console route the banner's action links to.
  href: string;
}

export interface ConfigHealth {
  issues: ConfigHealthIssue[];
}
