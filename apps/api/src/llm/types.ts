// Provider-neutral contract. The investigation domain talks to LLMs only
// through these shapes, never to a vendor SDK directly.

export interface ToolSchema {
  name: string;
  description: string;
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

// A single conversation turn in provider-neutral form. `content` is the human-
// readable text for the transcript; `providerContent` is the native message
// kept verbatim so a resumed run rebuilds a valid turn (the provider contract
// requires thinking/tool_use/tool_result pairing that text alone can't restore).
export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
  providerContent: unknown;
}

// Implement this interface to add a new provider, then wire it into createProvider.
export interface LLMProvider {
  start(firstMessage: string): void;
  // Restore a prior transcript so the loop can continue a session. start() is
  // the empty-history special case; seed() is the general entry (D10).
  seed(history: ProviderMessage[]): void;
  // Current conversation in neutral form, for incremental persistence.
  snapshot(): ProviderMessage[];
  // onDelta, when provided, receives live fragments as the turn streams; the
  // returned ChatResponse is unchanged whether or not it is passed.
  chat(tools: ToolSchema[], onDelta?: OnDelta): Promise<ChatResponse>;
  // additionalText, when provided, is appended to the same user message as the
  // tool results. Used to inject mid-run alerts at each tool boundary (D10).
  appendToolResults(results: ToolResult[], additionalText?: string): void;
  // Inject a human-authored user turn (chat / resume). Distinct from a
  // tool_result: add_context mid-approval must stay a tool_result (D10).
  appendUserMessage(message: string): void;
}
