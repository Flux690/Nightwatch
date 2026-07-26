import OpenAI from "openai";
import { logger } from "../logger.js";
import { messagePartsToText } from "@nightwarden/shared";
import type {
  MessagePart,
  ResolvedLLMConfig,
  WireDialect,
} from "@nightwarden/shared";
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

const DIALECT: WireDialect = "openai-chat";

// Works against any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, ...).
// OPENAI_BASE_URL selects the host; the model comes from the global config.
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly system: string;
  private readonly config: ResolvedLLMConfig;
  private readonly opts?: ProviderCallOptions;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  // Reasoning per turn, keyed by message index; finalChatCompletion() drops the
  // streamed OpenRouter reasoning_details, so it's captured separately here.
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
    // row once at first boot, never again. An unset baseUrl means the SDK's own
    // default endpoint, which is the correct value for OpenAI proper.
    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseUrl,
      timeout: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
    });
    this.model = config.model;
  }

  start(firstMessage: string): void {
    // OpenAI carries the system prompt as the first message, not a top-level field.
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
      const reasoningOff = this.opts?.reasoning === "off";
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
        // A call flagged reasoning-off spends its whole budget on visible text;
        // flat reasoning_effort is OpenAI-standard and OpenRouter accepts it as
        // an alias. Gated on reasoningEffort so deployments that never speak the
        // reasoning dialect keep sending nothing.
        ...(reasoningOff &&
          this.config.reasoningEffort && {
            reasoning_effort: "none" as const,
          }),
      };
      // OpenRouter-only param requesting reasoning_details on the stream; the
      // official SDK types don't know it, hence the cast through unknown.
      if (!reasoningOff && this.config.reasoningEffort) {
        (streamParams as unknown as Record<string, unknown>)["reasoning"] = {
          effort: this.config.reasoningEffort,
        };
      }
      const stream = this.client.chat.completions.stream(streamParams, {
        signal,
      });
      // SDK types omit OpenRouter's reasoning_details, hence the cast via unknown; listened
      // for unconditionally so accumulated text survives the no-callback wrap-up turn.
      stream.on("chunk", (chunk) => {
        const rawDelta = (
          chunk as unknown as {
            choices?: Array<{ delta?: Record<string, unknown> }>;
          }
        ).choices?.[0]?.delta;
        const entries = rawDelta?.["reasoning_details"] as
          Array<{ type: string; text?: string }> | undefined;
        for (const entry of entries ?? []) {
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
      // Surface OpenRouter/OpenAI status (429 rate limit, 503 provider down,
      // timeout) instead of a bare stack, then rethrow to fail the job.
      if (err instanceof OpenAI.APIError) {
        logger.error(
          { model: this.model, status: err.status, code: err.code, err },
          "OpenAI-compatible request failed",
        );
      } else {
        logger.error({ model: this.model, err }, "OpenAI request failed");
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

  appendToolResults(results: ToolResult[], additionalText?: string): void {
    for (const r of results) {
      // OpenAI has no is_error flag; fold it into the content the model reads.
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
    const text = m.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (text) out.push({ role: "user", content: text });
    return out;
  }

  const text = m.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

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
