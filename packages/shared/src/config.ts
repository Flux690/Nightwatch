// Global agent config: how the one brain reasons (no per-runner dimension). Every
// value here is API-seeded and safe to send to the frontend; keys are masked.

export type LLMProviderName = "anthropic" | "openrouter";
// "allowlist" routes all sandbox egress through an enforcing proxy that only
// reaches approved hosts; "none" gives no network at all; "open" is unrestricted.
export type SandboxNetwork = "allowlist" | "open" | "none";

// Served rather than hardcoded, so a new adapter appears in the frontend
// without a UI change.
export interface ProviderOption {
  name: LLMProviderName;
  label: string;
  defaultBaseUrl: string;
}

// `needs_key` is the provider's rule, not ours: OpenRouter publishes its
// catalog to anyone, Anthropic answers 401 without a key.
export type CatalogError = "needs_key" | "bad_key" | "unreachable";

// Listing the catalog is also how setup is verified: models coming back prove
// the endpoint is reachable and the key works, so nothing separate is pressed.
export type ModelCatalog =
  { ok: true; models: ModelOption[] } | { ok: false; error: CatalogError };

// One rung of a provider's reasoning ladder, in that provider's own vocabulary.
export interface ReasoningLevel {
  value: string;
  label: string;
}

// Normalised from whichever catalog it came from, so the frontend renders it
// and never branches on the provider name.
export interface ReasoningDescriptor {
  // "Effort" for Anthropic, "Reasoning" for OpenRouter.
  label: string;
  // Ordered strongest to weakest. Ladders have holes (Opus 4.6 has max but not
  // xhigh), so this is the authority rather than any assumed ordering.
  levels: ReasoningLevel[];
  defaultLevel: string;
}

// One entry of a provider's model catalog, with everything the settings form
// needs to render controls that fit that exact model.
export interface ModelOption {
  id: string;
  // null when the model exposes no reasoning control at all.
  reasoning: ReasoningDescriptor | null;
  // The model's own output ceiling, null when its catalog does not publish one.
  maxOutputTokens: number | null;
  // The model's context window, null when its catalog does not publish one.
  // Read rather than assumed: it is what a compaction trigger is derived from.
  maxInputTokens: number | null;
  // Whether the provider summarises a conversation that outgrows the window.
  // Stated by the catalog or false: one that truncates instead is not this.
  compaction: boolean;
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
  // Validated against the model's descriptor rather than a fixed union: the
  // levels differ per model, so an enum here could only be a guess.
  reasoningLevel: string | null;
  // Captured from the catalog when the model is saved, so nothing has to reach
  // the network to start a run. Null means the catalog published no ceiling.
  maxOutputTokens: number | null;
  // Captured with it, on the same terms.
  maxInputTokens: number | null;
  compaction: boolean;
  // Captured with the model rather than looked up again, so the settings form
  // draws its reasoning control from the config it already has. Null when none.
  reasoning: ReasoningDescriptor | null;
}

// Both providers hold the same shape: the user's choice plus the facts
// captured about the model they chose.
export type ProviderSettingsMap = Record<LLMProviderName, ProviderSettings>;

export interface AgentConfig {
  // Which provider block is live; null until a user picks one. There is no
  // default: a fresh install must not look configured when it can reach no LLM.
  provider: LLMProviderName | null;
  providers: ProviderSettingsMap;
  maxRetries: number;
  requestTimeoutMs: number;
  // Counts the suspended ones too: starting another only queues a second write
  // behind the same person.
  maxConcurrentInvestigations: number;
  // How long the agent works before finishing its current step and asking
  // whether to continue. The continue gate is what it reaches, not a kill.
  checkInAfterMs: number;
  // Upper bound on any single tool call. Tools declare their own lower limits.
  toolCallCeilingMs: number;
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

// Only the readiness gate builds one, so holding it is proof the install is
// configured and no call site has to re-check.
export interface ResolvedLLMConfig {
  provider: LLMProviderName;
  model: string;
  baseUrl?: string;
  // The chosen model's own ceiling, or a constant when it published none.
  maxOutputTokens: number;
  // Both are facts the catalog stated. What to do with them is each adapter's
  // arithmetic, so no threshold is decided here.
  maxInputTokens: number | null;
  compaction: boolean;
  maxRetries: number;
  requestTimeoutMs: number;
  // The user's pick, in the provider's vocabulary; each adapter translates
  // it into its own wire param. Null means send nothing and take the default.
  reasoningLevel: string | null;
  // The ladder the pick came from. Null means the model publishes none, and an
  // adapter with no ladder sends no reasoning params at all rather than guessing.
  reasoning: ReasoningDescriptor | null;
}
