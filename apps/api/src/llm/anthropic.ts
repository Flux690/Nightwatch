import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
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

// The terminal tool name. When native structured output is enabled, the
// Anthropic provider promotes this tool to output_config.format so the model
// produces a constrained JSON object rather than a tool invocation.
const FINAL_RESPONSE_TOOL_NAME = "final_response";

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly system: string;
  private readonly config: AgentConfig;
  private messages: Anthropic.Messages.MessageParam[] = [];

  constructor(system: string, config: AgentConfig, apiKey?: string) {
    this.system = system;
    this.config = config;
    // apiKey comes from the DB-stored encrypted key (decrypted by the caller)
    // when set, falling back to the env var for deployments that still use env.
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env["ANTHROPIC_API_KEY"],
      ...(config.baseUrl && { baseURL: config.baseUrl }),
      timeout: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
    });
    this.model = config.model;
  }

  start(firstMessage: string): void {
    this.messages = [{ role: "user", content: firstMessage }];
  }

  async chat(tools: ToolSchema[], onDelta?: OnDelta): Promise<ChatResponse> {
    const terminalTool = tools.find((t) => t.name === FINAL_RESPONSE_TOOL_NAME);
    const functionTools = terminalTool
      ? tools.filter((t) => t.name !== FINAL_RESPONSE_TOOL_NAME)
      : tools;

    let response: Anthropic.Messages.Message;
    try {
      // Stream and accumulate via finalMessage(): a large response (up to
      // maxOutputTokens) can no longer trip the single-read request timeout.
      // The returned Message is identical to a non-streamed one, so everything
      // downstream (content blocks, usage, stop_reason) is unchanged.
      const stream = this.client.messages.stream({
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
        tools: functionTools as Anthropic.Tool[],
        // When the terminal tool is present, native structured output replaces
        // it. output_config.format coexists with tool use: investigation tools
        // are still available; when the model is done it produces JSON matching
        // the schema in a text block (stop_reason: end_turn) rather than a
        // tool_use block.
        ...(terminalTool && {
          output_config: {
            format: {
              type: "json_schema" as const,
              schema: terminalTool.input_schema as { [key: string]: unknown },
            },
          },
        }),
        messages: this.messagesWithCacheBreakpoint(),
      });
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

    // When native structured output is used (terminalTool present) and the
    // model finished with stop_reason end_turn (no tool_use blocks), the text
    // block contains the structured JSON. Synthesize it as a final_response
    // ToolUse so the loop validates via InvestigationResultSchema — same path
    // as the tool-fallback. If JSON parsing fails, leave toolUses empty so the
    // loop's empty-tools guard escalates.
    if (
      terminalTool &&
      response.stop_reason === "end_turn" &&
      toolUses.length === 0 &&
      textBlock
    ) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        toolUses.push({
          id: randomUUID(),
          name: FINAL_RESPONSE_TOOL_NAME,
          input: parsed,
        });
      } catch {
        logger.warn(
          { model: this.model },
          "structured output text block was not valid JSON; escalating via empty toolUses",
        );
      }
    }

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
    // providerContent is the MessageParam stored verbatim on persist; the
    // role/content fallback only applies to messages that predate it.
    this.messages = history.map((m) =>
      m.providerContent != null
        ? (m.providerContent as Anthropic.Messages.MessageParam)
        : { role: m.role, content: m.content },
    );
  }

  snapshot(): ProviderMessage[] {
    return this.messages.map((m) => ({
      // Anthropic messages are only user/assistant; coerce for the neutral type.
      role: m.role === "assistant" ? "assistant" : "user",
      content: messageText(m),
      providerContent: m,
    }));
  }
}

function messageText(m: Anthropic.Messages.MessageParam): string {
  if (typeof m.content === "string") return m.content;
  const parts: string[] = [];
  for (const b of m.content) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "thinking") parts.push(b.thinking);
    else if (b.type === "tool_use") parts.push(`[tool_use: ${b.name}]`);
    else if (b.type === "tool_result")
      parts.push(typeof b.content === "string" ? b.content : "[tool_result]");
  }
  return parts.join("\n");
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
