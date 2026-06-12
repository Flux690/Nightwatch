import { db } from "../db/client.js";
import {
  DEFAULT_HARD_TIMEOUT_MS,
  DEFAULT_MAX_TOOL_CALLS,
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
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    hardTimeoutMs: DEFAULT_HARD_TIMEOUT_MS,
    toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    baseUrl,
    apiKeyMasked: null,
    promptCaching: true,
    reasoningEffort: null,
  };
}

export async function loadConfig(): Promise<AgentConfig> {
  const row = await db.config.findUnique({ where: { id: CONFIG_ID } });
  if (!row) return defaultConfigFromEnv();

  let apiKeyMasked: string | null = null;
  if (row.apiKeyEncrypted) {
    try {
      const plain = decrypt(row.apiKeyEncrypted);
      apiKeyMasked = maskKey(plain);
    } catch {
      // Decryption failure (e.g. rotated SECRET_KEY) — treat as unset.
      apiKeyMasked = null;
    }
  }

  return {
    provider: row.provider as LLMProviderName,
    model: row.model,
    thinking: row.thinking as ThinkingMode,
    maxOutputTokens: row.maxOutputTokens,
    maxRetries: row.maxRetries,
    requestTimeoutMs: row.requestTimeoutMs,
    maxToolCalls: row.maxToolCalls,
    hardTimeoutMs: row.hardTimeoutMs,
    toolTimeoutMs: row.toolTimeoutMs,
    baseUrl: row.baseUrl ?? undefined,
    apiKeyMasked,
    promptCaching: row.promptCaching,
    reasoningEffort: (row.reasoningEffort as ReasoningEffort | null) ?? null,
  };
}

// Returns the decrypted API key from DB, or undefined if none is stored.
export async function loadApiKey(): Promise<string | undefined> {
  const row = await db.config.findUnique({ where: { id: CONFIG_ID } });
  if (!row?.apiKeyEncrypted) return undefined;
  try {
    return decrypt(row.apiKeyEncrypted);
  } catch {
    return undefined;
  }
}

export async function updateConfig(
  patch: Partial<AgentConfig>,
): Promise<AgentConfig> {
  // Strip computed/internal fields before writing — they are never stored.
  const { apiKeyMasked: _masked, ...storable } = patch;
  const next: AgentConfig = { ...(await loadConfig()), ...patch };
  await db.config.upsert({
    where: { id: CONFIG_ID },
    create: {
      id: CONFIG_ID,
      provider: next.provider,
      model: next.model,
      thinking: next.thinking,
      maxOutputTokens: next.maxOutputTokens,
      maxRetries: next.maxRetries,
      requestTimeoutMs: next.requestTimeoutMs,
      maxToolCalls: next.maxToolCalls,
      hardTimeoutMs: next.hardTimeoutMs,
      toolTimeoutMs: next.toolTimeoutMs,
      baseUrl: next.baseUrl ?? null,
      promptCaching: next.promptCaching ?? true,
      reasoningEffort: next.reasoningEffort ?? null,
      ...("baseUrl" in storable && { baseUrl: storable.baseUrl ?? null }),
    },
    update: {
      provider: next.provider,
      model: next.model,
      thinking: next.thinking,
      maxOutputTokens: next.maxOutputTokens,
      maxRetries: next.maxRetries,
      requestTimeoutMs: next.requestTimeoutMs,
      maxToolCalls: next.maxToolCalls,
      hardTimeoutMs: next.hardTimeoutMs,
      toolTimeoutMs: next.toolTimeoutMs,
      baseUrl: next.baseUrl ?? null,
      promptCaching: next.promptCaching ?? true,
      reasoningEffort: next.reasoningEffort ?? null,
    },
  });
  return next;
}

// Persists the encrypted key without touching other config fields.
export async function saveApiKey(apiKeyEncrypted: string): Promise<void> {
  await db.config.upsert({
    where: { id: CONFIG_ID },
    create: {
      id: CONFIG_ID,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      thinking: "adaptive",
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: MAX_RETRIES,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
      hardTimeoutMs: DEFAULT_HARD_TIMEOUT_MS,
      toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      apiKeyEncrypted,
    },
    update: { apiKeyEncrypted },
  });
}
