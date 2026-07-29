import OpenAI from "openai";
import { logger } from "../logger.js";
import { messagePartsToText } from "@nightwarden/shared";
import type {
  MessagePart,
  ModelOption,
  ReasoningLevel,
  ResolvedLLMConfig,
  WireDialect,
} from "@nightwarden/shared";
import { resolveDefault } from "./reasoning.js";
import type {
  ChatResponse,
  LLMProvider,
  OnDelta,
  ProviderCallOptions,
  ProviderMessage,
  ToolResult,
  ToolSchema,
  ToolUse,
} from "./types.js";

const DIALECT: WireDialect = "openrouter-chat";

export const OPENROUTER_MODELS_PATH = "/models";
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

// The gateway's full ladder, strongest first. "none" is omitted: disabling is
// expressed by canDisable, so it never doubles as a rung the form could send.
const OPENROUTER_LADDER: readonly ReasoningLevel[] = [
  { value: "max", label: "Max" },
  { value: "xhigh", label: "Extra high" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "minimal", label: "Minimal" },
];

// Every model publishing levels also publishes its own default, so this only
// stands in for the models that publish neither, where the gateway accepts
// anything. Positional picks would be wrong at both ends: the ladder descends,
// so first is max and last is off.
const OPENROUTER_FALLBACK_EFFORT = "medium";

export function openRouterAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

// OpenRouter's extensions to the chat-completions contract, which the OpenAI
// SDK does not type. Declared here so reading them needs no casts.
interface OpenRouterReasoningParam {
  effort?: string;
  enabled?: boolean;
}

interface ReasoningDetail {
  type: string;
  text?: string;
}

// Reads reasoning_details off a stream chunk. The SDK types the chunk without
// this field, so every hop is checked rather than assumed.
function reasoningDetails(chunk: unknown): ReasoningDetail[] {
  if (typeof chunk !== "object" || chunk === null) return [];
  const choices = (chunk as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices)) return [];
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) return [];
  const delta = (first as Record<string, unknown>)["delta"];
  if (typeof delta !== "object" || delta === null) return [];
  const entries = (delta as Record<string, unknown>)["reasoning_details"];
  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entry): ReasoningDetail[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const e = entry as Record<string, unknown>;
    if (typeof e["type"] !== "string") return [];
    return [
      {
        type: e["type"],
        ...(typeof e["text"] === "string" && { text: e["text"] }),
      },
    ];
  });
}

// A model's reasoning block, as OpenRouter's catalog publishes it. Only
// `mandatory` is present on every entry; the rest are absent on most models.
interface OpenRouterReasoning {
  mandatory?: boolean;
  default_enabled?: boolean;
  supported_efforts?: string[];
  default_effort?: string;
  supports_max_tokens?: boolean;
}

function readReasoning(raw: unknown): OpenRouterReasoning | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const efforts = r["supported_efforts"];
  const defaultEffort = r["default_effort"];
  return {
    ...(typeof r["mandatory"] === "boolean" && { mandatory: r["mandatory"] }),
    ...(Array.isArray(efforts) && {
      supported_efforts: efforts.filter(
        (e): e is string => typeof e === "string",
      ),
    }),
    ...(typeof defaultEffort === "string" && { default_effort: defaultEffort }),
  };
}

// Normalises one page of OpenRouter's /models into the neutral shape the
// settings form renders.
export function describeOpenRouterModels(data: unknown): ModelOption[] {
  if (typeof data !== "object" || data === null) return [];
  const entries = (data as Record<string, unknown>)["data"];
  if (!Array.isArray(entries)) return [];

  return entries.flatMap((raw): ModelOption[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const entry = raw as Record<string, unknown>;
    const id = entry["id"];
    if (typeof id !== "string") return [];

    const reasoning = readReasoning(entry["reasoning"]);
    return [
      {
        id,
        reasoning: reasoning === null ? null : describeReasoning(reasoning),
        maxOutputTokens: maxCompletionTokens(entry["top_provider"]),
      },
    ];
  });
}

function describeReasoning(
  reasoning: OpenRouterReasoning,
): ModelOption["reasoning"] {
  // An absent list means the gateway accepts every value it knows.
  const listed = reasoning.supported_efforts;
  const levels =
    listed === undefined
      ? [...OPENROUTER_LADDER]
      : OPENROUTER_LADDER.filter((l) => listed.includes(l.value));
  if (levels.length === 0) return null;

  return {
    label: "Reasoning",
    levels,
    defaultLevel: resolveDefault(
      levels,
      reasoning.default_effort ?? OPENROUTER_FALLBACK_EFFORT,
    ),
    // OpenRouter's docs are explicit: for a mandatory model, hide the disable
    // control and never send effort "none", because the model rejects it.
    canDisable: reasoning.mandatory !== true,
  };
}

function maxCompletionTokens(topProvider: unknown): number | null {
  if (typeof topProvider !== "object" || topProvider === null) return null;
  const max = (topProvider as Record<string, unknown>)["max_completion_tokens"];
  return typeof max === "number" && max > 0 ? max : null;
}

// OpenRouter speaks the OpenAI chat-completions wire format, so the `openai`
// npm package is the transport OpenRouter itself recommends. Everything else
// here is OpenRouter's own dialect, not a generic compatibility shim.
export class OpenRouterProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly system: string;
  private readonly config: ResolvedLLMConfig;
  private readonly opts?: ProviderCallOptions;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  // Reasoning per turn, keyed by message index; finalChatCompletion() drops the
  // streamed reasoning_details, so it's captured separately here.
  private readonly thinkingByIndex = new Map<number, string>();

  constructor(
    system: string,
    config: ResolvedLLMConfig,
    apiKey?: string,
    opts?: ProviderCallOptions,
  ) {
    this.system = system;
    this.config = config;
    this.opts = opts;
    // The DB is the only runtime source for the key and base URL: env seeds that
    // row once at first boot, never again.
    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseUrl,
      timeout: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
    });
    this.model = config.model;
  }

  start(firstMessage: string): void {
    // This dialect carries the system prompt as the first message, not a top-level field.
    this.messages = [
      { role: "system", content: this.system },
      { role: "user", content: firstMessage },
    ];
  }

  async chat(
    tools: ToolSchema[],
    onDelta?: OnDelta,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    let response: OpenAI.Chat.Completions.ChatCompletion;
    let thinking = "";
    try {
      // Streamed via finalChatCompletion() so a large response can't trip the single-read
      // timeout; the accumulated result has the same shape as a non-streamed one.
      const streamParams = {
        model: this.model,
        max_tokens: this.config.maxOutputTokens,
        messages: this.messages,
        tools: tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
        ...this.reasoningParam(),
      };
      const stream = this.client.chat.completions.stream(streamParams, {
        signal,
      });
      // Listened for unconditionally so accumulated text survives the
      // no-callback wrap-up turn.
      stream.on("chunk", (chunk) => {
        for (const entry of reasoningDetails(chunk)) {
          if (
            (entry.type === "reasoning.text" ||
              entry.type === "reasoning.summary") &&
            entry.text
          ) {
            thinking += entry.text;
            onDelta?.({ kind: "thinking", text: entry.text });
          }
        }
      });
      if (onDelta) {
        stream.on("content", (delta) => onDelta({ kind: "text", text: delta }));
      }
      response = await stream.finalChatCompletion();
    } catch (err) {
      // Surface the status (429 rate limit, 502 provider down, timeout) instead
      // of a bare stack, then rethrow to fail the job.
      if (err instanceof OpenAI.APIError) {
        logger.error(
          { model: this.model, status: err.status, code: err.code, err },
          "OpenRouter request failed",
        );
      } else {
        logger.error({ model: this.model, err }, "OpenRouter request failed");
      }
      throw err;
    }

    const choice = response.choices[0];
    if (!choice) return { stopReason: "end_turn", toolUses: [], text: "" };

    if (thinking) this.thinkingByIndex.set(this.messages.length, thinking);
    this.messages.push(choice.message);

    const toolUses: ToolUse[] = [];
    for (const call of choice.message.tool_calls ?? []) {
      if (call.type !== "function") continue;
      toolUses.push({
        id: call.id,
        name: call.function.name,
        input: parseToolArguments(call.function.arguments, call.function.name),
      });
    }

    return {
      stopReason: mapStopReason(choice.finish_reason),
      toolUses,
      text: choice.message.content ?? "",
    };
  }

  // OpenRouter's own param, absent from the OpenAI SDK's types. Requesting it is
  // also what makes reasoning_details stream back.
  private reasoningParam(): { reasoning?: OpenRouterReasoningParam } {
    const level = this.config.reasoningLevel;
    if (this.opts?.reasoning === "off") {
      // A mandatory model rejects being switched off, and OpenRouter's docs say
      // not to ask: hide the control and never send effort "none".
      if (!this.config.reasoningCanDisable) return {};
      return { reasoning: { enabled: false } };
    }
    return level === null ? {} : { reasoning: { effort: level } };
  }

  appendToolResults(results: ToolResult[], additionalText?: string): void {
    for (const r of results) {
      // This dialect has no is_error flag; fold it into the content the model reads.
      this.messages.push({
        role: "tool",
        tool_call_id: r.tool_use_id,
        content: r.is_error ? `ERROR: ${r.content}` : r.content,
      });
    }
    if (additionalText) {
      this.messages.push({ role: "user", content: additionalText });
    }
  }

  appendUserMessage(message: string): void {
    this.messages.push({ role: "user", content: message });
  }

  seed(history: ProviderMessage[]): void {
    // System prompt lives in the message array here, not the transcript, so it is
    // re-prepended. Own-dialect messages replay verbatim; others rebuild from parts.
    this.messages = [
      { role: "system", content: this.system },
      ...history.flatMap((m) =>
        m.native?.dialect === DIALECT
          ? [
              m.native
                .message as OpenAI.Chat.Completions.ChatCompletionMessageParam,
            ]
          : toNativeMessages(m),
      ),
    ];
  }

  snapshot(): ProviderMessage[] {
    // The system message is not part of the transcript; skip it.
    return this.messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.role !== "system")
      .map(({ m, i }) => {
        const parts = this.toParts(m, i);
        return {
          // A native "tool" message is a tool result, which is a user turn in the
          // neutral shape - the roles differ, so it is mapped rather than coerced.
          role:
            m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: messagePartsToText(parts),
          parts,
          native: { dialect: DIALECT, message: m },
        };
      });
  }

  private toParts(
    m: OpenAI.Chat.Completions.ChatCompletionMessageParam,
    index: number,
  ): MessagePart[] {
    if (m.role === "tool") {
      return [
        {
          type: "tool_result",
          toolCallId: m.tool_call_id,
          output: typeof m.content === "string" ? m.content : "",
        },
      ];
    }

    const content = typeof m.content === "string" ? m.content : "";
    if (m.role !== "assistant") {
      return content ? [{ type: "text", text: content }] : [];
    }

    const parts: MessagePart[] = [];
    const reasoning = this.thinkingByIndex.get(index);
    if (reasoning?.trim()) parts.push({ type: "reasoning", text: reasoning });
    if (content) parts.push({ type: "text", text: content });
    for (const call of m.tool_calls ?? []) {
      if (call.type !== "function") continue;
      parts.push({
        type: "tool_call",
        id: call.id,
        name: call.function.name,
        input: parseToolArguments(call.function.arguments, call.function.name),
      });
    }
    return parts;
  }
}

// Rebuild native messages from parts. One turn can become several: each tool
// result is its own "tool" message here, and reasoning has no field to land in.
function toNativeMessages(
  m: ProviderMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const text = m.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  const toolResults = m.parts.filter((p) => p.type === "tool_result");
  if (toolResults.length > 0) {
    const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      toolResults.map((p) => ({
        role: "tool" as const,
        tool_call_id: p.toolCallId,
        // No is_error flag here, so it folds into the content the model reads.
        content: p.isError ? `ERROR: ${p.output}` : p.output,
      }));
    // Injected text rides alongside tool results; it needs its own turn here.
    if (text) out.push({ role: "user", content: text });
    return out;
  }

  if (m.role !== "assistant") {
    return [{ role: "user", content: text || m.content }];
  }

  const toolCalls = m.parts
    .filter((p) => p.type === "tool_call")
    .map((p) => ({
      id: p.id,
      type: "function" as const,
      function: { name: p.name, arguments: JSON.stringify(p.input) },
    }));
  return [
    {
      role: "assistant",
      content: text || null,
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    },
  ];
}

// Model-generated JSON can be malformed; a bad payload becomes empty input,
// which per-tool validation rejects with a corrective error instead of crashing.
function parseToolArguments(
  raw: string,
  toolName: string,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    logger.warn(
      { tool: toolName, raw },
      "tool arguments were not a JSON object",
    );
    return {};
  } catch {
    logger.warn({ tool: toolName, raw }, "tool arguments were not valid JSON");
    return {};
  }
}

function mapStopReason(
  reason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"],
): ChatResponse["stopReason"] {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  return "end_turn";
}
