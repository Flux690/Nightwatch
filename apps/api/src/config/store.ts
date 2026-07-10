import { getDb } from "../db/client.js";
import {
  DEFAULT_CODE_SESSION_BUDGET_MS,
  DEFAULT_HARD_TIMEOUT_MS,
  DEFAULT_REMEDIATION_BREAKER_LIMIT,
  DEFAULT_REMEDIATION_BREAKER_WINDOW_MS,
  DEFAULT_SANDBOX_CPUS,
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_MEMORY_MB,
  DEFAULT_SANDBOX_REQUIRE_GVISOR,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
} from "../llm/config.js";
import { decrypt, maskKey } from "./crypto.js";
import type {
  AgentConfig,
  LLMProviderName,
  ReasoningEffort,
  ThinkingMode,
} from "@nightwatch/shared";

const CONFIG_ID = "global";

// Shape of the config row as selected (columns aliased to camelCase). The
// provider/thinking/reasoningEffort columns are plain TEXT, constrained to their
// enums on write via the route schema. promptCaching is stored as 0/1.
type ConfigRow = {
  provider: string;
  model: string;
  thinking: string;
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
  baseUrl: string | null;
  apiKeyEncrypted: string | null;
  promptCaching: number;
  reasoningEffort: string | null;
};

const SELECT_ROW = `
  SELECT provider, model, thinking,
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
         base_url           AS baseUrl,
         api_key_encrypted  AS apiKeyEncrypted,
         prompt_caching     AS promptCaching,
         reasoning_effort   AS reasoningEffort
  FROM config WHERE id = ?
`;

function readRow(): ConfigRow | undefined {
  // better-sqlite3 returns untyped rows; the column aliases match ConfigRow.
  return getDb().prepare(SELECT_ROW).get(CONFIG_ID) as ConfigRow | undefined;
}

function defaultConfigFromEnv(): AgentConfig {
  const provider: LLMProviderName =
    process.env["LLM_PROVIDER"] === "openai" ? "openai" : "anthropic";
  const model =
    provider === "openai"
      ? (process.env["OPENAI_MODEL"] ?? "openai/gpt-oss-120b:free")
      : (process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6");
  const baseUrl =
    provider === "openai"
      ? (process.env["OPENAI_BASE_URL"] ?? undefined)
      : undefined;
  return {
    provider,
    model,
    thinking: "adaptive",
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
    baseUrl,
    apiKeyMasked: null,
    promptCaching: true,
    reasoningEffort: null,
  };
}

export function loadConfig(): AgentConfig {
  const row = readRow();
  if (!row) return defaultConfigFromEnv();

  let apiKeyMasked: string | null = null;
  if (row.apiKeyEncrypted) {
    try {
      apiKeyMasked = maskKey(decrypt(row.apiKeyEncrypted));
    } catch {
      // Decryption failure (e.g. rotated SECRET_KEY) - treat as unset.
      apiKeyMasked = null;
    }
  }

  return {
    // Columns are plain TEXT; the route schema constrains writes to these enums.
    provider: row.provider as LLMProviderName,
    model: row.model,
    thinking: row.thinking as ThinkingMode,
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
    baseUrl: row.baseUrl ?? undefined,
    apiKeyMasked,
    promptCaching: row.promptCaching === 1,
    reasoningEffort: (row.reasoningEffort as ReasoningEffort | null) ?? null,
  };
}

// Returns the decrypted API key from the DB, or undefined if none is stored.
export function loadApiKey(): string | undefined {
  const row = readRow();
  if (!row?.apiKeyEncrypted) return undefined;
  try {
    return decrypt(row.apiKeyEncrypted);
  } catch {
    return undefined;
  }
}

const UPSERT_CONFIG = `
  INSERT INTO config (
    id, provider, model, thinking, max_output_tokens, max_retries,
    request_timeout_ms, hard_timeout_ms, tool_timeout_ms,
    remediation_breaker_limit, remediation_breaker_window_ms,
    code_session_budget_ms, sandbox_idle_timeout_ms, sandbox_cpus, sandbox_memory_mb,
    sandbox_require_gvisor,
    base_url, prompt_caching, reasoning_effort, updated_at
  ) VALUES (
    @id, @provider, @model, @thinking, @maxOutputTokens, @maxRetries,
    @requestTimeoutMs, @hardTimeoutMs, @toolTimeoutMs,
    @remediationBreakerLimit, @remediationBreakerWindowMs,
    @codeSessionBudgetMs, @sandboxIdleTimeoutMs, @sandboxCpus, @sandboxMemoryMb,
    @sandboxRequireGvisor,
    @baseUrl, @promptCaching, @reasoningEffort, @updatedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    provider = excluded.provider,
    model = excluded.model,
    thinking = excluded.thinking,
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
    base_url = excluded.base_url,
    prompt_caching = excluded.prompt_caching,
    reasoning_effort = excluded.reasoning_effort,
    updated_at = excluded.updated_at
`;

export function updateConfig(patch: Partial<AgentConfig>): AgentConfig {
  // apiKeyMasked is computed on read and never stored; the encrypted key is
  // written only through saveApiKey, so the upsert above leaves it untouched.
  const next: AgentConfig = { ...loadConfig(), ...patch };
  getDb()
    .prepare(UPSERT_CONFIG)
    .run({
      id: CONFIG_ID,
      provider: next.provider,
      model: next.model,
      thinking: next.thinking,
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
      baseUrl: next.baseUrl ?? null,
      promptCaching: next.promptCaching ? 1 : 0,
      reasoningEffort: next.reasoningEffort ?? null,
      updatedAt: new Date().toISOString(),
    });
  return next;
}

// Persists the encrypted key without touching other config fields. On first
// write the row is created with column defaults for everything else.
export function saveApiKey(apiKeyEncrypted: string): void {
  getDb()
    .prepare(
      `INSERT INTO config (id, api_key_encrypted, updated_at)
       VALUES (@id, @apiKeyEncrypted, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         api_key_encrypted = excluded.api_key_encrypted,
         updated_at = excluded.updated_at`,
    )
    .run({
      id: CONFIG_ID,
      apiKeyEncrypted,
      updatedAt: new Date().toISOString(),
    });
}
