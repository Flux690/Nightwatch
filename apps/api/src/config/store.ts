import { getDb } from "../db.js";
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
import { PROVIDER_OPTIONS } from "../llm/catalog.js";
import { decrypt, encrypt, maskKey } from "../secrets.js";
import { logger } from "../logger.js";
import type {
  AgentConfig,
  LLMProviderName,
  ProviderSettings,
  ProviderSettingsMap,
  SandboxNetwork,
} from "@nightwarden/shared";

const CONFIG_ID = "global";

// One list of providers in the build, held where they are described.
const PROVIDER_NAMES: readonly LLMProviderName[] = PROVIDER_OPTIONS.map(
  (p) => p.name,
);

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
};

function readConfigRow(): Promise<ConfigRow | undefined> {
  return getDb()
    .selectFrom("config")
    .select([
      "active_provider as activeProvider",
      "max_retries as maxRetries",
      "request_timeout_ms as requestTimeoutMs",
      "max_concurrent_investigations as maxConcurrentInvestigations",
      "check_in_after_ms as checkInAfterMs",
      "tool_call_ceiling_ms as toolCallCeilingMs",
      "sandbox_idle_timeout_ms as sandboxIdleTimeoutMs",
      "sandbox_cpus as sandboxCpus",
      "sandbox_memory_mb as sandboxMemoryMb",
      "sandbox_require_gvisor as sandboxRequireGvisor",
      "sandbox_network as sandboxNetwork",
      "sandbox_allowlist_hosts as sandboxAllowlistHosts",
    ])
    .where("id", "=", CONFIG_ID)
    .executeTakeFirst();
}

function readProviderRow(
  provider: LLMProviderName,
): Promise<ProviderRow | undefined> {
  return getDb()
    .selectFrom("provider_config")
    .select([
      "provider",
      "model",
      "base_url as baseUrl",
      "api_key_encrypted as apiKeyEncrypted",
      "reasoning_level as reasoningLevel",
    ])
    .where("provider", "=", provider)
    .executeTakeFirst();
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
    // Decryption failure (e.g. rotated NIGHTWARDEN_SECRET_KEY) - treat as unset.
    return null;
  }
}

function toSettings(row: ProviderRow | undefined): ProviderSettings {
  return {
    model: row?.model ?? null,
    baseUrl: row?.baseUrl ?? undefined,
    apiKeyMasked: maskStored(row?.apiKeyEncrypted ?? null),
    reasoningLevel: row?.reasoningLevel ?? null,
  };
}

async function loadProviders(): Promise<ProviderSettingsMap> {
  return {
    anthropic: toSettings(await readProviderRow("anthropic")),
    openai: toSettings(await readProviderRow("openai")),
    openrouter: toSettings(await readProviderRow("openrouter")),
  };
}

// Operational defaults are engineering choices and stay; which provider is active
// is the user's to pick, so it starts null and the run gate refuses until set.
export async function loadConfig(): Promise<AgentConfig> {
  const row = await readConfigRow();
  const providers = await loadProviders();
  if (!row) {
    return {
      provider: null,
      providers,
      providerOptions: [...PROVIDER_OPTIONS],
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
    providerOptions: [...PROVIDER_OPTIONS],
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
export async function loadApiKey(
  provider: LLMProviderName,
): Promise<string | undefined> {
  const row = await readProviderRow(provider);
  if (!row?.apiKeyEncrypted) return undefined;
  try {
    return decrypt(row.apiKeyEncrypted);
  } catch {
    return undefined;
  }
}

// Global settings only; the per-provider blocks are written by updateProvider so
// a change to one provider can never disturb the other.
type GlobalConfigPatch = Partial<Omit<AgentConfig, "providers">>;

export async function updateConfig(
  patch: GlobalConfigPatch,
): Promise<AgentConfig> {
  const next: AgentConfig = { ...(await loadConfig()), ...patch };
  const values = {
    active_provider: next.provider,
    max_retries: next.maxRetries,
    request_timeout_ms: next.requestTimeoutMs,
    max_concurrent_investigations: next.maxConcurrentInvestigations,
    check_in_after_ms: next.checkInAfterMs,
    tool_call_ceiling_ms: next.toolCallCeilingMs,
    sandbox_idle_timeout_ms: next.sandboxIdleTimeoutMs,
    sandbox_cpus: next.sandboxCpus,
    sandbox_memory_mb: next.sandboxMemoryMb,
    sandbox_require_gvisor: next.sandboxRequireGvisor ? 1 : 0,
    sandbox_network: next.sandboxNetwork,
    sandbox_allowlist_hosts: next.sandboxAllowlistHosts.join("\n"),
    updated_at: new Date().toISOString(),
  };
  await getDb()
    .insertInto("config")
    .values({ id: CONFIG_ID, ...values })
    .onConflict((oc) => oc.column("id").doUpdateSet(values))
    .execute();
  return next;
}

export interface ProviderPatch {
  model?: string | null;
  baseUrl?: string | null;
  reasoningLevel?: string | null;
  // Plaintext; encrypted here so no caller has to remember to.
  apiKey?: string;
}

// Fields absent from the patch keep their stored value; the key is only replaced
// when a new one is supplied, so saving a model never clears the credential.
export async function updateProvider(
  provider: LLMProviderName,
  patch: ProviderPatch,
): Promise<AgentConfig> {
  const existing = await readProviderRow(provider);
  const values = {
    provider,
    model: patch.model !== undefined ? patch.model : (existing?.model ?? null),
    base_url:
      patch.baseUrl !== undefined
        ? (patch.baseUrl ?? null)
        : (existing?.baseUrl ?? null),
    api_key_encrypted:
      patch.apiKey !== undefined
        ? encrypt(patch.apiKey)
        : (existing?.apiKeyEncrypted ?? null),
    reasoning_level:
      patch.reasoningLevel !== undefined
        ? patch.reasoningLevel
        : (existing?.reasoningLevel ?? null),
    updated_at: new Date().toISOString(),
  };
  await getDb()
    .insertInto("provider_config")
    .values(values)
    .onConflict((oc) => oc.column("provider").doUpdateSet(values))
    .execute();
  return await loadConfig();
}

// Env is a first-boot seed, never a live source, so the database stays the one
// runtime source of truth.
export async function seedConfigFromEnv(): Promise<void> {
  for (const provider of PROVIDER_NAMES) {
    await seedProviderFromEnv(provider);
  }

  const requested = process.env["NIGHTWARDEN_LLM_PROVIDER"];
  if (requested === undefined || requested === "") return;
  // Matched against the list rather than asserted, so the name is narrowed by
  // the same value the rest of this file iterates.
  const provider = PROVIDER_NAMES.find((name) => name === requested);
  if (provider === undefined) {
    logger.warn(
      { requested, expected: PROVIDER_NAMES },
      "NIGHTWARDEN_LLM_PROVIDER names no provider this build has; leaving the active provider unset",
    );
    return;
  }
  if ((await loadConfig()).provider !== null) return;

  // Activating a block that cannot run would produce an install that looks
  // configured and fails at the first alert, so require the model and key first.
  const block = await readProviderRow(provider);
  if (!block?.model || !block.apiKeyEncrypted) {
    logger.warn(
      { provider },
      "NIGHTWARDEN_LLM_PROVIDER is set but that provider has no model and key; finish setup in the frontend",
    );
    return;
  }
  await updateConfig({ provider });
  logger.info({ provider }, "active LLM provider seeded from environment");
}

async function seedProviderFromEnv(provider: LLMProviderName): Promise<void> {
  // Only an untouched block is seeded: once a user has saved anything for a
  // provider, the database owns it and a stale compose file cannot overwrite it.
  const existing = await readProviderRow(provider);
  if (existing?.model || existing?.apiKeyEncrypted) return;

  const prefix = provider.toUpperCase();
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

  await updateProvider(provider, {
    model,
    apiKey,
    ...(baseUrl !== undefined && baseUrl !== "" && { baseUrl }),
  });
  logger.info({ provider, model }, "seeded provider settings from environment");
}
