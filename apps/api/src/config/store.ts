import { db } from "../db/client.js";
import {
  DEFAULT_HARD_TIMEOUT_MS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
} from "../llm/config.js";
import type {
  AgentConfig,
  LLMProviderName,
  ThinkingMode,
} from "@nightwatch/shared";

// Single-row table; the row id is constant.
const CONFIG_ID = "global";

// The seed/default for the global config: env where it exists, the shared
// constants otherwise. API keys are deliberately absent - they stay in env and
// are read directly by the providers, never stored or surfaced here.
function defaultConfigFromEnv(): AgentConfig {
  const provider: LLMProviderName =
    process.env["LLM_PROVIDER"] === "openai" ? "openai" : "anthropic";
  const model =
    provider === "openai"
      ? (process.env["OPENAI_MODEL"] ?? "openai/gpt-oss-120b:free")
      : (process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6");
  return {
    provider,
    model,
    thinking: "adaptive",
    structuredOutput: true,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxRetries: MAX_RETRIES,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    hardTimeoutMs: DEFAULT_HARD_TIMEOUT_MS,
    toolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  };
}

export async function loadConfig(): Promise<AgentConfig> {
  const row = await db.config.findUnique({ where: { id: CONFIG_ID } });
  if (!row) return defaultConfigFromEnv();
  return {
    // provider/thinking are stored as plain TEXT; they are only ever written
    // through updateConfig, which validates them against the union.
    provider: row.provider as LLMProviderName,
    model: row.model,
    thinking: row.thinking as ThinkingMode,
    structuredOutput: row.structuredOutput,
    maxOutputTokens: row.maxOutputTokens,
    maxRetries: row.maxRetries,
    requestTimeoutMs: row.requestTimeoutMs,
    maxToolCalls: row.maxToolCalls,
    hardTimeoutMs: row.hardTimeoutMs,
    toolTimeoutMs: row.toolTimeoutMs,
  };
}

export async function updateConfig(
  patch: Partial<AgentConfig>,
): Promise<AgentConfig> {
  const next: AgentConfig = { ...(await loadConfig()), ...patch };
  await db.config.upsert({
    where: { id: CONFIG_ID },
    create: { id: CONFIG_ID, ...next },
    update: next,
  });
  return next;
}
