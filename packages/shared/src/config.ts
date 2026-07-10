// Global agent config: how the one brain reasons (no per-runner dimension). The API
// stores one row seeded from env; secrets stay in env, so this shape is safe to send
// to the console.

export type LLMProviderName = "anthropic" | "openai";
export type ThinkingMode = "adaptive" | "off";
export type ReasoningEffort = "low" | "medium" | "high";
// "allowlist" enforces the egress domain list (deny by default); "open" leaves
// the sandbox on the default bridge with unrestricted outbound.
export type SandboxEgressPolicy = "allowlist" | "open";

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
  // Code sessions: any repo tool call re-extends the session deadline to
  // codeSessionBudgetMs; the sandbox knobs bound the per-session container.
  codeSessionBudgetMs: number;
  sandboxIdleTimeoutMs: number;
  sandboxCpus: number;
  sandboxMemoryMb: number;
  // When true, a sandbox refuses to start unless the Docker host provides the
  // gVisor (runsc) runtime - fail-loud for hosts that must guarantee
  // kernel-syscall isolation. Off by default: gVisor is used automatically
  // wherever present and falls back to the hardened container otherwise.
  sandboxRequireGvisor: boolean;
  // Sandbox network egress: policy plus the allowed hostnames (each entry
  // covers its subdomains). Deny-by-default with the allowlist enforced by a
  // filtering proxy the sandbox is forced through.
  sandboxEgressPolicy: SandboxEgressPolicy;
  sandboxEgressAllowlist: string[];
  // Provider endpoint config. baseUrl overrides the SDK default; apiKeyMasked
  // is computed server-side (never stored) and shows the configured key hint.
  baseUrl?: string;
  apiKeyMasked?: string | null;
  // Provider-native tuning. promptCaching applies to Anthropic; reasoningEffort
  // applies to OpenAI-class endpoints.
  promptCaching?: boolean;
  reasoningEffort?: ReasoningEffort | null;
}
