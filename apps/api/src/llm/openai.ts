import OpenAI from "openai";
import { logger } from "../logger.js";
import type { AgentConfig } from "@nightwatch/shared";
import type {
  ChatResponse,
  LLMProvider,
  OnDelta,
  ProviderMessage,
  ToolResult,
  ToolSchema,
  ToolUse,
} from "./types.js";

// Neutral content-block shape the console's persistedConverter already knows how
// to read (mirrors Anthropic's native blocks). OpenAI's own message shape has no
// field for reasoning, so a turn that thinks gets reassembled into this shape
// before it is persisted - otherwise the reasoning is visible only while it
// streams and is lost the moment the turn is written to the transcript.
type ProviderBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

// Works against any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, ...).
// OPENAI_BASE_URL selects the host; the model comes from the global config.
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly system: string;
  private readonly config: AgentConfig;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  // Reasoning text accumulated per assistant turn, keyed by its index in
  // `messages`. Captured from streamed `reasoning_details` chunks, which the
  // OpenAI SDK's finalChatCompletion() accumulator drops (it's an
  // OpenRouter-only extension), so it has to be tracked separately here.
  private readonly thinkingByIndex = new Map<number, string>();

  constructor(system: string, config: AgentConfig, apiKey?: string) {
    this.system = system;
    this.config = config;
    // apiKey comes from the DB-stored encrypted key (decrypted by the caller)
    // when set, falling back to the env var. baseUrl from config overrides the
    // env var so operators can change endpoints without a server restart.
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env["OPENAI_API_KEY"],
      baseURL: config.baseUrl ?? process.env["OPENAI_BASE_URL"],
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

  async chat(tools: ToolSchema[], onDelta?: OnDelta): Promise<ChatResponse> {
    let response: OpenAI.Chat.Completions.ChatCompletion;
    let thinking = "";
    try {
      // Stream and accumulate via finalChatCompletion(): a large response (up
      // to maxOutputTokens) can't trip the single-read request timeout. The
      // accumulated completion has the same shape as a non-streamed one, so
      // everything downstream is unchanged.
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
      };
      // OpenRouter-only param requesting reasoning_details on the stream; the
      // official SDK types don't know it, hence the cast through unknown.
      if (this.config.reasoningEffort) {
        (streamParams as unknown as Record<string, unknown>)["reasoning"] = {
          effort: this.config.reasoningEffort,
        };
      }
      const stream = this.client.chat.completions.stream(streamParams);
      // OpenRouter extends the delta with reasoning_details; the official SDK types omit it,
      // so the cast goes through unknown first to satisfy the compiler. Listened
      // for unconditionally (not just when onDelta is passed) so the
      // accumulated text below survives even on the no-callback wrap-up turn.
      stream.on("chunk", (chunk) => {
        const rawDelta = (
          chunk as unknown as {
            choices?: Array<{ delta?: Record<string, unknown> }>;
          }
        ).choices?.[0]?.delta;
        const entries = rawDelta?.["reasoning_details"] as
          | Array<{ type: string; text?: string }>
          | undefined;
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
        // OpenAI returns arguments as a JSON string; parse to the neutral input shape.
        input: JSON.parse(call.function.arguments) as Record<string, unknown>,
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
    // The system prompt lives in the message array for OpenAI, so it is
    // re-prepended here rather than restored from the transcript. Messages
    // persisted without providerContent (predating its introduction) fall
    // back to a plain role/content reconstruction, matching Anthropic.
    this.messages = [
      { role: "system", content: this.system },
      ...history.map((m) => this.toNativeMessage(m)),
    ];
  }

  // A turn that thought is persisted as a ProviderBlock[] (see snapshot()),
  // which OpenAI's API won't accept back as input - the reasoning isn't
  // needed to replay context, so it's dropped and only text/tool_calls
  // round-trip into a native message.
  private toNativeMessage(
    m: ProviderMessage,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    if (Array.isArray(m.providerContent)) {
      const blocks = m.providerContent as ProviderBlock[];
      const toolResult = blocks.find(
        (b): b is ProviderBlock & { type: "tool_result" } =>
          b.type === "tool_result",
      );
      // A tool's output round-trips as its own native "tool" message, not an
      // assistant turn - the console persists it under role "user" (see
      // snapshot()) purely for display grouping.
      if (toolResult) {
        return {
          role: "tool",
          tool_call_id: toolResult.tool_use_id,
          content:
            typeof toolResult.content === "string"
              ? toolResult.content
              : JSON.stringify(toolResult.content),
        };
      }
      const text = blocks.find((b) => b.type === "text")?.text ?? null;
      const toolCalls = blocks
        .filter(
          (b): b is ProviderBlock & { type: "tool_use" } =>
            b.type === "tool_use",
        )
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      return {
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      };
    }
    if (m.providerContent != null) {
      return m.providerContent as OpenAI.Chat.Completions.ChatCompletionMessageParam;
    }
    return { role: m.role, content: m.content };
  }

  snapshot(): ProviderMessage[] {
    // The system message is not part of the transcript; skip it.
    return this.messages
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.role !== "system")
      .map(({ m, i }) => {
        // A tool's output is always reconstructed as the same ProviderBlock[]
        // shape the console reads for Anthropic, regardless of which provider
        // ran - persisted under role "user" purely for display grouping.
        if (m.role === "tool") {
          const blocks: ProviderBlock[] = [
            {
              type: "tool_result",
              tool_use_id: m.tool_call_id,
              content: m.content,
            },
          ];
          return {
            role: "user" as const,
            content: typeof m.content === "string" ? m.content : "",
            providerContent: blocks,
          };
        }

        const content = typeof m.content === "string" ? m.content : "";

        if (m.role === "assistant") {
          // Always build the block shape (even with no thinking and no tool
          // calls) so the console's persistedConverter, which only recognizes
          // ProviderBlock[] for assistant turns, renders every turn the same way.
          const thinking = this.thinkingByIndex.get(i);
          const blocks: ProviderBlock[] = [];
          if (thinking) blocks.push({ type: "thinking", thinking });
          if (content) blocks.push({ type: "text", text: content });
          for (const call of m.tool_calls ?? []) {
            if (call.type !== "function") continue;
            blocks.push({
              type: "tool_use",
              id: call.id,
              name: call.function.name,
              input: JSON.parse(call.function.arguments) as Record<
                string,
                unknown
              >,
            });
          }
          return {
            role: "assistant" as const,
            content,
            providerContent: blocks,
          };
        }

        return {
          role: "user" as const,
          content,
          providerContent: m,
        };
      });
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
