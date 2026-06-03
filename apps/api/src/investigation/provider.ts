import Anthropic from "@anthropic-ai/sdk";
import type { ToolSchema } from "./tools.js";

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ChatResponse {
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  toolUses: ToolUse[];
  text: string;
}

/* Implement this interface to add a new LLM provider (e.g. OpenAIProvider). */
export interface LLMProvider {
  start(firstMessage: string): void;
  chat(tools: ToolSchema[]): Promise<ChatResponse>;
  appendToolResults(results: ToolResult[]): void;
}

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;
  private readonly system: string;
  private messages: Anthropic.Messages.MessageParam[] = [];

  constructor(system: string) {
    this.system = system;
    this.client = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
  }

  start(firstMessage: string): void {
    this.messages = [{ role: "user", content: firstMessage }];
  }

  async chat(tools: ToolSchema[]): Promise<ChatResponse> {
    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: this.system,
      // ToolSchema is structurally compatible with Anthropic.Tool
      tools: tools as Anthropic.Tool[],
      messages: this.messages,
    });

    this.messages.push({ role: "assistant", content: response.content });

    const toolUses: ToolUse[] = response.content
      .filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
      )
      .map((b) => ({
        id: b.id,
        name: b.name,
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
