// Provider-neutral contract. The investigation domain talks to LLMs only
// through these shapes, never to a vendor SDK directly.

export interface ToolSchema {
  name: string;
  description: string;
  // When true, the provider constrains tool input to the schema (Anthropic
  // strict tools / OpenAI strict function calling). Used by the terminal
  // `conclude` tool so its output is schema-guaranteed, not free text.
  strict?: boolean;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

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
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
  toolUses: ToolUse[];
  text: string;
}

// A live token fragment emitted while a turn streams. `thinking` is the model's
// reasoning (Anthropic adaptive thinking); `text` is the visible answer.
export interface StreamDelta {
  kind: "text" | "thinking";
  text: string;
}

export type OnDelta = (delta: StreamDelta) => void;

// Implement this interface to add a new provider, then wire it into createProvider.
export interface LLMProvider {
  start(firstMessage: string): void;
  // onDelta, when provided, receives live fragments as the turn streams; the
  // returned ChatResponse is unchanged whether or not it is passed.
  chat(tools: ToolSchema[], onDelta?: OnDelta): Promise<ChatResponse>;
  appendToolResults(results: ToolResult[]): void;
}
