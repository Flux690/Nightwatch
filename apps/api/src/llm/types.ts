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

// Implement this interface to add a new provider, then wire it into createProvider.
export interface LLMProvider {
  start(firstMessage: string): void;
  chat(tools: ToolSchema[]): Promise<ChatResponse>;
  appendToolResults(results: ToolResult[]): void;
}
