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

// Works against any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, ...).
// OPENAI_BASE_URL selects the host; the model comes from the global config.
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly system: string;
  private readonly config: AgentConfig;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  constructor(system: string, config: AgentConfig) {
    this.system = system;
    this.config = config;
    // API key stays in env and is never part of AgentConfig.
    this.client = new OpenAI({
      apiKey: process.env["OPENAI_API_KEY"],
      baseURL: process.env["OPENAI_BASE_URL"],
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
    try {
      // Stream and accumulate via finalChatCompletion(): a large response (up
      // to maxOutputTokens) can't trip the single-read request timeout. The
      // accumulated completion has the same shape as a non-streamed one, so
      // everything downstream is unchanged.
      const stream = this.client.chat.completions.stream({
        model: this.model,
        max_tokens: this.config.maxOutputTokens,
        messages: this.messages,
        tools: tools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
            // Strict function calling constrains the model's arguments to the
            // schema - the terminal `conclude` tool relies on this so its
            // output is validated, not free text.
            ...(t.strict && { strict: true }),
          },
        })),
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

  appendToolResults(results: ToolResult[]): void {
    for (const r of results) {
      // OpenAI has no is_error flag; fold it into the content the model reads.
      this.messages.push({
        role: "tool",
        tool_call_id: r.tool_use_id,
        content: r.is_error ? `ERROR: ${r.content}` : r.content,
      });
    }
  }

  appendUserMessage(message: string): void {
    this.messages.push({ role: "user", content: message });
  }

  seed(history: ProviderMessage[]): void {
    // The system prompt lives in the message array for OpenAI, so it is
    // re-prepended here rather than restored from the transcript.
    this.messages = [
      { role: "system", content: this.system },
      ...history.map(
        (m) =>
          m.providerContent as OpenAI.Chat.Completions.ChatCompletionMessageParam,
      ),
    ];
  }

  snapshot(): ProviderMessage[] {
    // The system message is not part of the transcript; skip it. Tool-role
    // messages are persisted on the user side for display, native role kept.
    return this.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: typeof m.content === "string" ? m.content : "",
        providerContent: m,
      }));
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
