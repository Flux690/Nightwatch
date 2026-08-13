import { z } from "zod";
import { getDb } from "../db/client.js";
import {
  DEFAULT_CHECK_IN_AFTER_MS,
  DEFAULT_MAX_CONCURRENT_INVESTIGATIONS,
  DEFAULT_SANDBOX_ALLOWLIST_HOSTS,
  DEFAULT_SANDBOX_CPUS,
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_MEMORY_MB,
  DEFAULT_SANDBOX_NETWORK,
  DEFAULT_SANDBOX_REQUIRE_GVISOR,
  DEFAULT_TOOL_CALL_CEILING_MS,
  MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
} from "../llm/config.js";
import { decrypt, encrypt, maskKey } from "../secrets.js";
import { logger } from "../logger.js";
import type {
  AgentConfig,
  LLMProviderName,
  ProviderSettings,
  ProviderSettingsMap,
  ReasoningDescriptor,
  SandboxNetwork,
} from "@nightwarden/shared";

const CONFIG_ID = "global";

const PROVIDER_NAMES: readonly LLMProviderName[] = ["anthropic", "openrouter"];

type ConfigRow = {
  activeProvider: string | null;
  maxRetries: number;
  requestTimeoutMs: number;
  maxConcurrentInvestigations: number;
  checkInAfterMs: number;
  toolCallCeilingMs: number;
  sandboxIdleTimeoutMs: number;
  sandboxCpus: number;
  sandboxMemoryMb: number;
  sandboxRequireGvisor: number;
  sandboxNetwork: string;
  sandboxAllowlistHosts: string;
};

// reasoning_level is plain TEXT: the legal values come from the chosen model's
// descriptor, so no column constraint could express them.
type ProviderRow = {
  provider: string;
  model: string | null;
  baseUrl: string | null;
  apiKeyEncrypted: string | null;
  reasoningLevel: string | null;
  maxOutputTokens: number | null;
  reasoning: string | null;
};

const SELECT_CONFIG = `
  SELECT active_provider    AS activeProvider,
         max_retries        AS maxRetries,
         request_timeout_ms AS requestTimeoutMs,
         max_concurrent_investigations AS maxConcurrentInvestigations,
         check_in_after_ms  AS checkInAfterMs,
         tool_call_ceiling_ms AS toolCallCeilingMs,
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
         base_url              AS baseUrl,
         api_key_encrypted     AS apiKeyEncrypted,
         reasoning_level       AS reasoningLevel,
         max_output_tokens     AS maxOutputTokens,
         reasoning
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

// Stored as JSON because the ladder is the catalog's shape, not ours: its length
// and vocabulary differ per model, so columns could only ever hold one provider's.
const ReasoningDescriptorSchema = z.object({
  label: z.string(),
  levels: z.array(z.object({ value: z.string(), label: z.string() })),
  defaultLevel: z.string(),
  canDisable: z.boolean(),
});

// A row written by an older shape, or hand-edited, reads as no ladder rather
// than crashing the whole config read.
function parseReasoning(json: string | null): ReasoningDescriptor | null {
  if (json === null) return null;
  try {
    const parsed = ReasoningDescriptorSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toSettings(row: ProviderRow | undefined): ProviderSettings {
  return {
    model: row?.model ?? null,
    baseUrl: row?.baseUrl ?? undefined,
    apiKeyMasked: maskStored(row?.apiKeyEncrypted ?? null),
    reasoningLevel: row?.reasoningLevel ?? null,
    maxOutputTokens: row?.maxOutputTokens ?? null,
    reasoning: parseReasoning(row?.reasoning ?? null),
  };
}

function loadProviders(): ProviderSettingsMap {
  return {
    anthropic: toSettings(readProviderRow("anthropic")),
    openrouter: toSettings(readProviderRow("openrouter")),
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
      maxRetries: MAX_RETRIES,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxConcurrentInvestigations: DEFAULT_MAX_CONCURRENT_INVESTIGATIONS,
      checkInAfterMs: DEFAULT_CHECK_IN_AFTER_MS,
      toolCallCeilingMs: DEFAULT_TOOL_CALL_CEILING_MS,
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
    maxRetries: row.maxRetries,
    requestTimeoutMs: row.requestTimeoutMs,
    maxConcurrentInvestigations: row.maxConcurrentInvestigations,
    checkInAfterMs: row.checkInAfterMs,
    toolCallCeilingMs: row.toolCallCeilingMs,
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
    id, active_provider, max_retries,
    request_timeout_ms, max_concurrent_investigations,
    check_in_after_ms, tool_call_ceiling_ms,
    sandbox_idle_timeout_ms, sandbox_cpus, sandbox_memory_mb,
    sandbox_require_gvisor, sandbox_network, sandbox_allowlist_hosts, updated_at
  ) VALUES (
    @id, @activeProvider, @maxRetries,
    @requestTimeoutMs, @maxConcurrentInvestigations,
    @checkInAfterMs, @toolCallCeilingMs,
    @sandboxIdleTimeoutMs, @sandboxCpus, @sandboxMemoryMb,
    @sandboxRequireGvisor, @sandboxNetwork, @sandboxAllowlistHosts, @updatedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    active_provider = excluded.active_provider,
    max_retries = excluded.max_retries,
    request_timeout_ms = excluded.request_timeout_ms,
    max_concurrent_investigations = excluded.max_concurrent_investigations,
    check_in_after_ms = excluded.check_in_after_ms,
    tool_call_ceiling_ms = excluded.tool_call_ceiling_ms,
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
type GlobalConfigPatch = Partial<Omit<AgentConfig, "providers">>;

export function updateConfig(patch: GlobalConfigPatch): AgentConfig {
  const next: AgentConfig = { ...loadConfig(), ...patch };
  getDb()
    .prepare(UPSERT_CONFIG)
    .run({
      id: CONFIG_ID,
      activeProvider: next.provider,
      maxRetries: next.maxRetries,
      requestTimeoutMs: next.requestTimeoutMs,
      maxConcurrentInvestigations: next.maxConcurrentInvestigations,
      checkInAfterMs: next.checkInAfterMs,
      toolCallCeilingMs: next.toolCallCeilingMs,
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
  reasoningLevel?: string | null;
  maxOutputTokens?: number | null;
  reasoning?: ReasoningDescriptor | null;
  // Plaintext; encrypted here so no caller has to remember to.
  apiKey?: string;
}

const UPSERT_PROVIDER = `
  INSERT INTO provider_config (
    provider, model, base_url, api_key_encrypted,
    reasoning_level, max_output_tokens, reasoning, updated_at
  ) VALUES (
    @provider, @model, @baseUrl, @apiKeyEncrypted,
    @reasoningLevel, @maxOutputTokens, @reasoning, @updatedAt
  )
  ON CONFLICT(provider) DO UPDATE SET
    model = excluded.model,
    base_url = excluded.base_url,
    api_key_encrypted = excluded.api_key_encrypted,
    reasoning_level = excluded.reasoning_level,
    max_output_tokens = excluded.max_output_tokens,
    reasoning = excluded.reasoning,
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
      reasoningLevel:
        patch.reasoningLevel !== undefined
          ? patch.reasoningLevel
          : (existing?.reasoningLevel ?? null),
      maxOutputTokens:
        patch.maxOutputTokens !== undefined
          ? patch.maxOutputTokens
          : (existing?.maxOutputTokens ?? null),
      reasoning:
        patch.reasoning !== undefined
          ? patch.reasoning && JSON.stringify(patch.reasoning)
          : (existing?.reasoning ?? null),
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
  if (requested !== "anthropic" && requested !== "openrouter") {
    logger.warn(
      { requested },
      "LLM_PROVIDER is not 'anthropic' or 'openrouter'; leaving the active provider unset",
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

  const prefix = provider === "anthropic" ? "ANTHROPIC" : "OPENROUTER";
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
