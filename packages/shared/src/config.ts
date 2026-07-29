// Global agent config: how the one brain reasons (no per-runner dimension). Every
// value here is API-seeded and safe to send to the console; keys are masked.

export type LLMProviderName = "anthropic" | "openrouter";
// "allowlist" routes all sandbox egress through an enforcing proxy that only
// reaches approved hosts; "none" gives no network at all; "open" is unrestricted.
export type SandboxNetwork = "allowlist" | "open" | "none";

// One rung of a provider's reasoning ladder, in that provider's own vocabulary.
export interface ReasoningLevel {
  value: string;
  label: string;
}

// What one model advertises about reasoning, normalised from whichever catalog
// it came from. The console renders this and never branches on the provider
// name: the provider's own word arrives in `label`, its logic stays server-side.
export interface ReasoningDescriptor {
  // "Effort" for Anthropic, "Reasoning" for OpenRouter.
  label: string;
  // Ordered strongest to weakest. Ladders have holes (Opus 4.6 has max but not
  // xhigh), so this is the authority rather than any assumed ordering.
  levels: ReasoningLevel[];
  defaultLevel: string;
  // False when the model rejects being asked not to reason, so no off is offered.
  canDisable: boolean;
}

// One entry of a provider's model catalog, with everything the settings form
// needs to render controls that fit that exact model.
export interface ModelOption {
  id: string;
  // null when the model exposes no reasoning control at all.
  reasoning: ReasoningDescriptor | null;
  // The model's own output ceiling, null when its catalog does not publish one.
  maxOutputTokens: number | null;
}

// How to reach one provider. Each keeps its own credentials, so switching the
// active provider cannot carry the previous one's key or endpoint across.
export interface ProviderSettings {
  model: string | null;
  // Unset means the provider's own endpoint. Set it to reach a gateway or a
  // self-hosted deployment of the same API.
  baseUrl?: string;
  // Computed server-side on read and never stored; the plaintext never leaves.
  apiKeyMasked?: string | null;
  // The operator's pick from this model's ladder. A plain string, validated
  // against the model's descriptor rather than a fixed union: the levels differ
  // per provider and per model, so an enum here could only ever be a guess.
  reasoningLevel: string | null;
  // Captured from the catalog when the model is saved, so nothing has to reach
  // the network to start a run. Null means the catalog published no ceiling.
  maxOutputTokens: number | null;
  // False when the chosen model rejects being told not to reason, which the
  // one-shot title call has to respect.
  reasoningCanDisable: boolean;
}

// Both providers hold the same shape: the operator's choice plus the facts
// captured about the model they chose.
export type ProviderSettingsMap = Record<LLMProviderName, ProviderSettings>;

export interface AgentConfig {
  // Which provider block is live; null until an operator picks one. There is no
  // default: a fresh install must not look configured when it can reach no LLM.
  provider: LLMProviderName | null;
  providers: ProviderSettingsMap;
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
  // The chosen model's own ceiling, or a constant when it published none.
  maxOutputTokens: number;
  maxRetries: number;
  requestTimeoutMs: number;
  // The operator's pick, in the provider's vocabulary; each adapter translates
  // it into its own wire param. Null means send nothing and take the default.
  reasoningLevel: string | null;
  reasoningCanDisable: boolean;
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
