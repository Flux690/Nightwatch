import { randomUUID } from "node:crypto";
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

// The terminal tool name. The OpenAI provider promotes this tool to a native
// response_format instead of passing it as a function call, so the model
// produces a JSON object rather than a tool invocation.
const FINAL_RESPONSE_TOOL_NAME = "final_response";

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
    // Separate the terminal tool from the investigation tools. When structured
    // output is enabled (the default), promote final_response to response_format
    // so the model produces a JSON object rather than a tool invocation. When
    // disabled, pass final_response as a normal strict function tool (fallback).
    const useStructuredOutput = this.config.structuredOutput !== false;
    const terminalTool = useStructuredOutput
      ? tools.find((t) => t.name === FINAL_RESPONSE_TOOL_NAME)
      : undefined;
    const functionTools = terminalTool
      ? tools.filter((t) => t.name !== FINAL_RESPONSE_TOOL_NAME)
      : tools;

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
        tools: functionTools.map((t) => ({
          type: "function" as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
            // Strict function calling constrains the model's arguments to the
            // schema - the terminal `final_response` tool relies on this so
            // its output is validated, not free text.
            ...(t.strict && { strict: true }),
          },
        })),
        // When the terminal tool is present, native structured output replaces
        // it. The model outputs a JSON object that the loop validates against
        // InvestigationResultSchema - same path as the tool-fallback.
        ...(terminalTool && {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: terminalTool.name,
              strict: true,
              schema: terminalTool.input_schema,
            },
          },
        }),
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

    // When native structured output was used (terminalTool present) and the
    // model finished with no tool calls, the response content is the structured
    // JSON. Synthesize it as a final_response ToolUse so the loop validates and
    // dispatches it through the same path as the tool-fallback. If JSON parsing
    // fails (unexpected from json_schema mode, but possible on provider error),
    // return empty toolUses and let the loop escalate via its empty-tools guard.
    if (
      terminalTool &&
      choice.finish_reason === "stop" &&
      toolUses.length === 0
    ) {
      const content = choice.message.content ?? "";
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        toolUses.push({
          id: randomUUID(),
          name: FINAL_RESPONSE_TOOL_NAME,
          input: parsed,
        });
      } catch {
        logger.warn(
          { model: this.model },
          "structured output content was not valid JSON; escalating via empty toolUses",
        );
      }
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
