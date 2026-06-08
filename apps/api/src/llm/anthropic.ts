import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger.js";
import type { AgentConfig } from "@nightwatch/shared";
import type {
  ChatResponse,
  LLMProvider,
  ToolResult,
  ToolSchema,
  ToolUse,
} from "./types.js";

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly system: string;
  private readonly config: AgentConfig;
  private messages: Anthropic.Messages.MessageParam[] = [];

  constructor(system: string, config: AgentConfig) {
    this.system = system;
    this.config = config;
    // API key stays in env and is never part of AgentConfig.
    this.client = new Anthropic({
      apiKey: process.env["ANTHROPIC_API_KEY"],
      timeout: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
    });
    this.model = config.model;
  }

  start(firstMessage: string): void {
    this.messages = [{ role: "user", content: firstMessage }];
  }

  async chat(tools: ToolSchema[]): Promise<ChatResponse> {
    let response: Anthropic.Messages.Message;
    try {
      // Stream and accumulate via finalMessage(): a large response (up to
      // MAX_OUTPUT_TOKENS) can no longer trip the single-read request timeout.
      // The returned Message is identical to a non-streamed one, so everything
      // downstream (content blocks, usage, stop_reason) is unchanged.
      response = await this.client.messages
        .stream({
          model: this.model,
          max_tokens: this.config.maxOutputTokens,
          // A single cache breakpoint on the system block caches the stable
          // system + tools prefix, which is identical on every loop turn.
          system: [
            {
              type: "text",
              text: this.system,
              cache_control: { type: "ephemeral" },
            },
          ],
          // Adaptive thinking lets the model decide when and how deeply to
          // reason; full response.content (incl. thinking blocks) is preserved
          // below for multi-turn continuity. Omitted entirely when disabled.
          ...(this.config.thinking === "adaptive" && {
            thinking: { type: "adaptive" as const },
          }),
          // ToolSchema is structurally compatible with Anthropic.Tool.
          tools: tools as Anthropic.Tool[],
          messages: this.messagesWithCacheBreakpoint(),
        })
        .finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        logger.error(
          { model: this.model, status: err.status, err },
          "Anthropic request failed",
        );
      } else {
        logger.error({ model: this.model, err }, "Anthropic request failed");
      }
      throw err;
    }

    logger.debug(
      {
        model: this.model,
        cacheRead: response.usage.cache_read_input_tokens,
        cacheWrite: response.usage.cache_creation_input_tokens,
        input: response.usage.input_tokens,
      },
      "Anthropic usage",
    );

    this.messages.push({ role: "assistant", content: response.content });

    const toolUses: ToolUse[] = response.content
      .filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      )
      .map((b) => ({
        id: b.id,
        name: b.name,
        // Anthropic types tool input as unknown; the loop narrows per tool.
        input: b.input as Record<string, unknown>,
      }));

    const text =
      response.content.find(
        (b): b is Anthropic.Messages.TextBlock => b.type === "text",
      )?.text ?? "";

    return {
      stopReason: mapStopReason(response.stop_reason),
      toolUses,
      text,
    };
  }

  // Place a rolling cache breakpoint on the tail of the conversation so the
  // growing message history is cached incrementally across turns. History is
  // append-only, so each turn's prefix matches the breakpoint written last
  // turn. chat() is only ever called when the last message is the user turn
  // (initial string, or tool_result blocks); we mark the final tool_result.
  // The persisted history stays free of breakpoints to avoid accumulation.
  private messagesWithCacheBreakpoint(): Anthropic.Messages.MessageParam[] {
    const lastIdx = this.messages.length - 1;
    const last = this.messages[lastIdx];
    if (!last || typeof last.content === "string") return this.messages;

    const blocks = last.content;
    const tailIdx = blocks.length - 1;
    const tail = blocks[tailIdx];
    if (tail?.type !== "tool_result") return this.messages;

    const marked: Anthropic.Messages.ToolResultBlockParam = {
      ...tail,
      cache_control: { type: "ephemeral" },
    };
    return [
      ...this.messages.slice(0, lastIdx),
      { ...last, content: [...blocks.slice(0, tailIdx), marked] },
    ];
  }

  appendToolResults(results: ToolResult[]): void {
    this.messages.push({
      role: "user",
      content: results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        ...(r.is_error && { is_error: true }),
      })),
    });
  }
}

function mapStopReason(
  reason: Anthropic.Messages.StopReason | null,
): ChatResponse["stopReason"] {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    // end_turn, stop_sequence, pause_turn, null all mean "the model is done
    // for now with no tool call" - the loop treats that as a normal stop.
    default:
      return "end_turn";
  }
}
