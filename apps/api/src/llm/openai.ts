import OpenAI from "openai";
import type {
  ChatResponse,
  LLMProvider,
  ToolResult,
  ToolSchema,
  ToolUse,
} from "./provider.js";

// Works against any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, ...).
// OPENAI_BASE_URL selects the host; OPENAI_MODEL selects the model.
export class OpenAIProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly system: string;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  constructor(system: string) {
    this.system = system;
    this.client = new OpenAI({
      apiKey: process.env["OPENAI_API_KEY"],
      baseURL: process.env["OPENAI_BASE_URL"],
    });
    this.model = process.env["OPENAI_MODEL"] ?? "openai/gpt-oss-120b:free";
  }

  start(firstMessage: string): void {
    // OpenAI carries the system prompt as the first message, not a top-level field.
    this.messages = [
      { role: "system", content: this.system },
      { role: "user", content: firstMessage },
    ];
  }

  async chat(tools: ToolSchema[]): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: this.messages,
      tools: tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      })),
    });

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
}

function mapStopReason(
  reason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"],
): ChatResponse["stopReason"] {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}
