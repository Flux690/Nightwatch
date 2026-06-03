import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../logger.js";
import type {
  ChatResponse,
  LLMProvider,
  ToolResult,
  ToolSchema,
  ToolUse,
} from "./provider.js";

// Bound each request so a slow call can't hang the job past the loop budget;
// the SDK default is 10 minutes.
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly system: string;
  private messages: Anthropic.Messages.MessageParam[] = [];

  constructor(system: string) {
    this.system = system;
    this.client = new Anthropic({
      apiKey: process.env["ANTHROPIC_API_KEY"],
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: MAX_RETRIES,
    });
    this.model = process.env["ANTHROPIC_MODEL"] ?? "claude-sonnet-4-6";
  }

  start(firstMessage: string): void {
    this.messages = [{ role: "user", content: firstMessage }];
  }

  async chat(tools: ToolSchema[]): Promise<ChatResponse> {
    let response: Anthropic.Messages.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: this.system,
        // ToolSchema is structurally compatible with Anthropic.Tool.
        tools: tools as Anthropic.Tool[],
        messages: this.messages,
      });
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
      stopReason: response.stop_reason as ChatResponse["stopReason"],
      toolUses,
      text,
    };
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
