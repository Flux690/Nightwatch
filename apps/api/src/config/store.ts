import { getDb } from "../db/client.js";
import {
  DEFAULT_CODE_SESSION_BUDGET_MS,
  DEFAULT_HARD_TIMEOUT_MS,
  DEFAULT_REMEDIATION_BREAKER_LIMIT,
  DEFAULT_REMEDIATION_BREAKER_WINDOW_MS,
  DEFAULT_SANDBOX_ALLOWLIST_HOSTS,
  DEFAULT_SANDBOX_CPUS,
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_MEMORY_MB,
  DEFAULT_SANDBOX_NETWORK,
  DEFAULT_SANDBOX_REQUIRE_GVISOR,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
} from "../llm/config.js";
import { decrypt, encrypt, maskKey } from "./crypto.js";
import { logger } from "../logger.js";
import type {
  AgentConfig,
  LLMProviderName,
  ProviderSettingsMap,
  ReasoningEffort,
  SandboxNetwork,
  ThinkingMode,
} from "@nightwarden/shared";

const CONFIG_ID = "global";

export const PROVIDER_NAMES: readonly LLMProviderName[] = [
  "anthropic",
  "openai",
];

type ConfigRow = {
  activeProvider: string | null;
  maxOutputTokens: number;
  maxRetries: number;
  requestTimeoutMs: number;
  hardTimeoutMs: number;
  toolTimeoutMs: number;
  remediationBreakerLimit: number;
  remediationBreakerWindowMs: number;
  codeSessionBudgetMs: number;
  sandboxIdleTimeoutMs: number;
  sandboxCpus: number;
  sandboxMemoryMb: number;
  sandboxRequireGvisor: number;
  sandboxNetwork: string;
  sandboxAllowlistHosts: string;
};

// thinking/reasoning_effort are plain TEXT, constrained to their enums on write
// by the route schema; each is inert for the provider it does not belong to.
type ProviderRow = {
  provider: string;
  model: string | null;
  baseUrl: string | null;
  apiKeyEncrypted: string | null;
  thinking: string;
  reasoningEffort: string | null;
};

const SELECT_CONFIG = `
  SELECT active_provider    AS activeProvider,
         max_output_tokens  AS maxOutputTokens,
         max_retries        AS maxRetries,
         request_timeout_ms AS requestTimeoutMs,
         hard_timeout_ms    AS hardTimeoutMs,
         tool_timeout_ms    AS toolTimeoutMs,
         remediation_breaker_limit     AS remediationBreakerLimit,
         remediation_breaker_window_ms AS remediationBreakerWindowMs,
         code_session_budget_ms  AS codeSessionBudgetMs,
         sandbox_idle_timeout_ms AS sandboxIdleTimeoutMs,
         sandbox_cpus            AS sandboxCpus,
         sandbox_memory_mb       AS sandboxMemoryMb,
         sandbox_require_gvisor  AS sandboxRequireGvisor,
         sandbox_network         AS sandboxNetwork,
         sandbox_allowlist_hosts AS sandboxAllowlistHosts
  FROM config WHERE id = ?
`;

const SELECT_PROVIDER = `
  SELECT provider, model,
         base_url          AS baseUrl,
         api_key_encrypted AS apiKeyEncrypted,
         thinking,
         reasoning_effort  AS reasoningEffort
  FROM provider_config WHERE provider = ?
`;

function readConfigRow(): ConfigRow | undefined {
  // better-sqlite3 returns untyped rows; the column aliases match ConfigRow.
  return getDb().prepare(SELECT_CONFIG).get(CONFIG_ID) as ConfigRow | undefined;
}

function readProviderRow(provider: LLMProviderName): ProviderRow | undefined {
  return getDb().prepare(SELECT_PROVIDER).get(provider) as
    ProviderRow | undefined;
}

// Stored newline-joined (the Settings textarea shape); empty lines dropped.
function splitHosts(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function maskStored(apiKeyEncrypted: string | null): string | null {
  if (!apiKeyEncrypted) return null;
  try {
    return maskKey(decrypt(apiKeyEncrypted));
  } catch {
    // Decryption failure (e.g. rotated SECRET_KEY) - treat as unset.
    return null;
  }
}

function loadProviders(): ProviderSettingsMap {
  const anthropic = readProviderRow("anthropic");
  const openai = readProviderRow("openai");
  return {
    anthropic: {
      model: anthropic?.model ?? null,
      baseUrl: anthropic?.baseUrl ?? undefined,
      apiKeyMasked: maskStored(anthropic?.apiKeyEncrypted ?? null),
      thinking: (anthropic?.thinking as ThinkingMode | undefined) ?? "adaptive",
    },
    openai: {
      model: openai?.model ?? null,
      baseUrl: openai?.baseUrl ?? undefined,
      apiKeyMasked: maskStored(openai?.apiKeyEncrypted ?? null),
      reasoningEffort:
        (openai?.reasoningEffort as ReasoningEffort | null | undefined) ?? null,
    },
  };
}

// Operational defaults are engineering choices and stay; which provider is active
// is the operator's to pick, so it starts null and the run gate refuses until set.
export function loadConfig(): AgentConfig {
  const row = readConfigRow();
  const providers = loadProviders();
  if (!row) {
    return {
      provider: null,
      providers,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: MAX_RETRIES,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      hardTimeoutMs: DEFAULT_HARD_TIMEOUT_MS,
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      remediationBreakerLimit: DEFAULT_REMEDIATION_BREAKER_LIMIT,
      remediationBreakerWindowMs: DEFAULT_REMEDIATION_BREAKER_WINDOW_MS,
      codeSessionBudgetMs: DEFAULT_CODE_SESSION_BUDGET_MS,
      sandboxIdleTimeoutMs: DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
      sandboxCpus: DEFAULT_SANDBOX_CPUS,
      sandboxMemoryMb: DEFAULT_SANDBOX_MEMORY_MB,
      sandboxRequireGvisor: DEFAULT_SANDBOX_REQUIRE_GVISOR,
      sandboxNetwork: DEFAULT_SANDBOX_NETWORK,
      sandboxAllowlistHosts: [...DEFAULT_SANDBOX_ALLOWLIST_HOSTS],
    };
  }

  return {
    provider: row.activeProvider as LLMProviderName | null,
    providers,
    maxOutputTokens: row.maxOutputTokens,
    maxRetries: row.maxRetries,
    requestTimeoutMs: row.requestTimeoutMs,
    hardTimeoutMs: row.hardTimeoutMs,
    toolTimeoutMs: row.toolTimeoutMs,
    remediationBreakerLimit: row.remediationBreakerLimit,
    remediationBreakerWindowMs: row.remediationBreakerWindowMs,
    codeSessionBudgetMs: row.codeSessionBudgetMs,
    sandboxIdleTimeoutMs: row.sandboxIdleTimeoutMs,
    sandboxCpus: row.sandboxCpus,
    sandboxMemoryMb: row.sandboxMemoryMb,
    sandboxRequireGvisor: row.sandboxRequireGvisor === 1,
    sandboxNetwork: row.sandboxNetwork as SandboxNetwork,
    sandboxAllowlistHosts: splitHosts(row.sandboxAllowlistHosts),
  };
}

// The decrypted key for one provider, or undefined when it has none stored.
export function loadApiKey(provider: LLMProviderName): string | undefined {
  const row = readProviderRow(provider);
  if (!row?.apiKeyEncrypted) return undefined;
  try {
    return decrypt(row.apiKeyEncrypted);
  } catch {
    return undefined;
  }
}

const UPSERT_CONFIG = `
  INSERT INTO config (
    id, active_provider, max_output_tokens, max_retries,
    request_timeout_ms, hard_timeout_ms, tool_timeout_ms,
    remediation_breaker_limit, remediation_breaker_window_ms,
    code_session_budget_ms, sandbox_idle_timeout_ms, sandbox_cpus, sandbox_memory_mb,
    sandbox_require_gvisor, sandbox_network, sandbox_allowlist_hosts, updated_at
  ) VALUES (
    @id, @activeProvider, @maxOutputTokens, @maxRetries,
    @requestTimeoutMs, @hardTimeoutMs, @toolTimeoutMs,
    @remediationBreakerLimit, @remediationBreakerWindowMs,
    @codeSessionBudgetMs, @sandboxIdleTimeoutMs, @sandboxCpus, @sandboxMemoryMb,
    @sandboxRequireGvisor, @sandboxNetwork, @sandboxAllowlistHosts, @updatedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    active_provider = excluded.active_provider,
    max_output_tokens = excluded.max_output_tokens,
    max_retries = excluded.max_retries,
    request_timeout_ms = excluded.request_timeout_ms,
    hard_timeout_ms = excluded.hard_timeout_ms,
    tool_timeout_ms = excluded.tool_timeout_ms,
    remediation_breaker_limit = excluded.remediation_breaker_limit,
    remediation_breaker_window_ms = excluded.remediation_breaker_window_ms,
    code_session_budget_ms = excluded.code_session_budget_ms,
    sandbox_idle_timeout_ms = excluded.sandbox_idle_timeout_ms,
    sandbox_cpus = excluded.sandbox_cpus,
    sandbox_memory_mb = excluded.sandbox_memory_mb,
    sandbox_require_gvisor = excluded.sandbox_require_gvisor,
    sandbox_network = excluded.sandbox_network,
    sandbox_allowlist_hosts = excluded.sandbox_allowlist_hosts,
    updated_at = excluded.updated_at
`;

// Global settings only; the per-provider blocks are written by updateProvider so
// a change to one provider can never disturb the other.
export type GlobalConfigPatch = Partial<Omit<AgentConfig, "providers">>;

export function updateConfig(patch: GlobalConfigPatch): AgentConfig {
  const next: AgentConfig = { ...loadConfig(), ...patch };
  getDb()
    .prepare(UPSERT_CONFIG)
    .run({
      id: CONFIG_ID,
      activeProvider: next.provider,
      maxOutputTokens: next.maxOutputTokens,
      maxRetries: next.maxRetries,
      requestTimeoutMs: next.requestTimeoutMs,
      hardTimeoutMs: next.hardTimeoutMs,
      toolTimeoutMs: next.toolTimeoutMs,
      remediationBreakerLimit: next.remediationBreakerLimit,
      remediationBreakerWindowMs: next.remediationBreakerWindowMs,
      codeSessionBudgetMs: next.codeSessionBudgetMs,
      sandboxIdleTimeoutMs: next.sandboxIdleTimeoutMs,
      sandboxCpus: next.sandboxCpus,
      sandboxMemoryMb: next.sandboxMemoryMb,
      sandboxRequireGvisor: next.sandboxRequireGvisor ? 1 : 0,
      sandboxNetwork: next.sandboxNetwork,
      sandboxAllowlistHosts: next.sandboxAllowlistHosts.join("\n"),
      updatedAt: new Date().toISOString(),
    });
  return next;
}

export interface ProviderPatch {
  model?: string | null;
  baseUrl?: string | null;
  thinking?: ThinkingMode;
  reasoningEffort?: ReasoningEffort | null;
  // Plaintext; encrypted here so no caller has to remember to.
  apiKey?: string;
}

const UPSERT_PROVIDER = `
  INSERT INTO provider_config (
    provider, model, base_url, api_key_encrypted, thinking, reasoning_effort, updated_at
  ) VALUES (
    @provider, @model, @baseUrl, @apiKeyEncrypted, @thinking, @reasoningEffort, @updatedAt
  )
  ON CONFLICT(provider) DO UPDATE SET
    model = excluded.model,
    base_url = excluded.base_url,
    api_key_encrypted = excluded.api_key_encrypted,
    thinking = excluded.thinking,
    reasoning_effort = excluded.reasoning_effort,
    updated_at = excluded.updated_at
`;

// Fields absent from the patch keep their stored value; the key is only replaced
// when a new one is supplied, so saving a model never clears the credential.
export function updateProvider(
  provider: LLMProviderName,
  patch: ProviderPatch,
): AgentConfig {
  const existing = readProviderRow(provider);
  getDb()
    .prepare(UPSERT_PROVIDER)
    .run({
      provider,
      model:
        patch.model !== undefined ? patch.model : (existing?.model ?? null),
      baseUrl:
        patch.baseUrl !== undefined
          ? (patch.baseUrl ?? null)
          : (existing?.baseUrl ?? null),
      apiKeyEncrypted:
        patch.apiKey !== undefined
          ? encrypt(patch.apiKey)
          : (existing?.apiKeyEncrypted ?? null),
      thinking: patch.thinking ?? existing?.thinking ?? "adaptive",
      reasoningEffort:
        patch.reasoningEffort !== undefined
          ? patch.reasoningEffort
          : (existing?.reasoningEffort ?? null),
      updatedAt: new Date().toISOString(),
    });
  return loadConfig();
}

// Env is a first-boot seed, never a live source, so the database stays the one
// runtime source of truth. Each provider reads only its own prefix, and
// LLM_PROVIDER alone decides which becomes active.
export function seedConfigFromEnv(): void {
  for (const provider of PROVIDER_NAMES) {
    seedProviderFromEnv(provider);
  }

  const requested = process.env["LLM_PROVIDER"];
  if (requested === undefined || requested === "") return;
  if (requested !== "anthropic" && requested !== "openai") {
    logger.warn(
      { requested },
      "LLM_PROVIDER is not 'anthropic' or 'openai'; leaving the active provider unset",
    );
    return;
  }
  if (loadConfig().provider !== null) return;

  // Activating a block that cannot run would produce an install that looks
  // configured and fails at the first alert, so require the model and key first.
  const block = readProviderRow(requested);
  if (!block?.model || !block.apiKeyEncrypted) {
    logger.warn(
      { provider: requested },
      "LLM_PROVIDER is set but that provider has no model and key; finish setup in the console",
    );
    return;
  }
  updateConfig({ provider: requested });
  logger.info(
    { provider: requested },
    "active LLM provider seeded from environment",
  );
}

function seedProviderFromEnv(provider: LLMProviderName): void {
  // Only an untouched block is seeded: once an operator has saved anything for a
  // provider, the database owns it and a stale compose file cannot overwrite it.
  const existing = readProviderRow(provider);
  if (existing?.model || existing?.apiKeyEncrypted) return;

  const prefix = provider === "anthropic" ? "ANTHROPIC" : "OPENAI";
  const model = process.env[`${prefix}_MODEL`];
  const apiKey = process.env[`${prefix}_API_KEY`];
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  if (!model && !apiKey && !baseUrl) return;

  if (!model || !apiKey) {
    const missing: string[] = [];
    if (!model) missing.push(`${prefix}_MODEL`);
    if (!apiKey) missing.push(`${prefix}_API_KEY`);
    logger.warn(
      { provider, missing },
      "incomplete provider environment; skipping seed for it",
    );
    return;
  }

  updateProvider(provider, {
    model,
    apiKey,
    ...(baseUrl !== undefined && baseUrl !== "" && { baseUrl }),
  });
  logger.info({ provider, model }, "seeded provider settings from environment");
}
