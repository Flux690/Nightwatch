import Anthropic from "@anthropic-ai/sdk";
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

const DIALECT: WireDialect = "anthropic-messages";

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly system: string;
  private readonly config: ResolvedLLMConfig;
  private readonly opts?: ProviderCallOptions;
  private messages: Anthropic.Messages.MessageParam[] = [];

  constructor(
    system: string,
    config: ResolvedLLMConfig,
    apiKey?: string,
    opts?: ProviderCallOptions,
  ) {
    this.system = system;
    this.config = config;
    this.opts = opts;
    // The DB is the only runtime source for the key: an env var is read once at
    // first boot to seed that row, never again, so there is no second source here.
    this.client = new Anthropic({
      apiKey,
      ...(config.baseUrl && { baseURL: config.baseUrl }),
      timeout: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
    });
    this.model = config.model;
  }

  start(firstMessage: string): void {
    this.messages = [{ role: "user", content: firstMessage }];
  }

  async chat(
    tools: ToolSchema[],
    onDelta?: OnDelta,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    let response: Anthropic.Messages.Message;
    try {
      // Stream and accumulate via finalMessage() so a large response can't trip the single-read
      // request timeout; the returned Message is identical to a non-streamed one.
      const stream = this.client.messages.stream(
        {
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
          // Adaptive thinking lets the model decide when and how deeply to reason; thinking
          // blocks are preserved in response.content below for multi-turn continuity.
          // Omitting the param entirely is Anthropic's "off" - used by calls
          // flagged reasoning-off (one-shot titles) regardless of config.
          ...(this.config.thinking === "adaptive" &&
            this.opts?.reasoning !== "off" && {
              thinking: { type: "adaptive" as const },
            }),
          // ToolSchema is structurally compatible with Anthropic.Tool.
          tools: tools as Anthropic.Tool[],
          messages: this.messagesWithCacheBreakpoint(),
        },
        { signal },
      );
      if (onDelta) {
        stream.on("text", (delta) => onDelta({ kind: "text", text: delta }));
        stream.on("thinking", (delta) =>
          onDelta({ kind: "thinking", text: delta }),
        );
      }
      response = await stream.finalMessage();
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

    const textBlock = response.content.find(
      (b): b is Anthropic.Messages.TextBlock => b.type === "text",
    );
    const text = textBlock?.text ?? "";

    return {
      stopReason: mapStopReason(response.stop_reason),
      toolUses,
      text,
    };
  }

  // Rolling cache breakpoint on the conversation tail so growing history caches incrementally;
  // marks only the final tool_result in-flight, so persisted history stays clean.
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

  appendToolResults(results: ToolResult[], additionalText?: string): void {
    const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] =
      results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        ...(r.is_error && { is_error: true }),
      }));
    this.messages.push({
      role: "user",
      content: additionalText
        ? [...toolResultBlocks, { type: "text" as const, text: additionalText }]
        : toolResultBlocks,
    });
  }

  appendUserMessage(message: string): void {
    this.messages.push({ role: "user", content: message });
  }

  seed(history: ProviderMessage[]): void {
    // A message this dialect wrote is replayed byte-exact: thinking blocks carry
    // signatures Anthropic rejects if altered. Anything else is rebuilt from parts,
    // which loses the reasoning and keeps the conversation.
    this.messages = history.map((m) =>
      m.native?.dialect === DIALECT
        ? (m.native.message as Anthropic.Messages.MessageParam)
        : toNativeMessage(m),
    );
  }

  snapshot(): ProviderMessage[] {
    return this.messages.map((m) => {
      const parts = toParts(m);
      return {
        // Anthropic messages are only user/assistant; coerce for the neutral type.
        role: m.role === "assistant" ? "assistant" : "user",
        content: messagePartsToText(parts),
        parts,
        native: { dialect: DIALECT, message: m },
      };
    });
  }
}

function toParts(m: Anthropic.Messages.MessageParam): MessagePart[] {
  if (typeof m.content === "string") {
    return m.content ? [{ type: "text", text: m.content }] : [];
  }
  const parts: MessagePart[] = [];
  for (const b of m.content) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "thinking")
      parts.push({ type: "reasoning", text: b.thinking });
    else if (b.type === "tool_use")
      parts.push({
        type: "tool_call",
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      });
    else if (b.type === "tool_result")
      parts.push({
        type: "tool_result",
        toolCallId: b.tool_use_id,
        output:
          typeof b.content === "string" ? b.content : JSON.stringify(b.content),
        ...(b.is_error && { isError: true }),
      });
  }
  return parts;
}

// Rebuild from parts for a message another dialect wrote. Reasoning is dropped
// rather than replayed: a thinking block without its original signature is rejected.
function toNativeMessage(m: ProviderMessage): Anthropic.Messages.MessageParam {
  const blocks: Anthropic.Messages.ContentBlockParam[] = [];
  for (const part of m.parts) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "tool_call") {
      blocks.push({
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.input,
      });
    } else if (part.type === "tool_result") {
      blocks.push({
        type: "tool_result",
        tool_use_id: part.toolCallId,
        content: part.output,
        ...(part.isError && { is_error: true }),
      });
    }
  }
  return blocks.length > 0
    ? { role: m.role, content: blocks }
    : { role: m.role, content: m.content };
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
