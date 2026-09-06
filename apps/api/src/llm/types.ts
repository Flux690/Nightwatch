// Provider-neutral contract. The investigation domain talks to LLMs only
// through these shapes, never to a vendor SDK directly.

import type {
  MessagePart,
  NativeEnvelope,
  ToolName,
} from "@nightwarden/shared";

export interface ToolSchema {
  // Checked against the shared list, so a tool the frontend draws by name cannot
  // be added or renamed here without the other end being made to agree.
  name: ToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolUse {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface ChatResponse {
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
  toolUses: ToolUse[];
  text: string;
  // What the record stores for this turn, so the run never reads its own
  // history back out of the provider.
  parts: MessagePart[];
  native?: NativeEnvelope;
}

// A live token fragment emitted while a turn streams. `thinking` is the model's
// reasoning (Anthropic adaptive thinking); `text` is the visible answer.
export interface StreamDelta {
  kind: "text" | "thinking";
  text: string;
}

export type OnDelta = (delta: StreamDelta) => void;

// One conversation turn: `parts` is the portable content, `native` the vendor's
// own message for a byte-exact same-dialect resume, `content` the text rendering.
export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
  parts: MessagePart[];
  native?: NativeEnvelope;
}

// Reasoning is never switched off, so the model's weakest rung is as low as a
// caller may ask for.
export interface ProviderCallOptions {
  minimalReasoning?: true;
}

// Implement this interface to add a new provider, then wire it into createProvider.
export interface LLMProvider {
  start(firstMessage: string): void;
  // Restore a prior transcript so the loop can continue a session. start() is
  // the empty-history special case; seed() is the general entry.
  seed(history: ProviderMessage[]): void;
  // `forceTool` is the provider's own tool_choice, so the turn cannot come
  // back as prose. The report turn depends on that.
  chat(
    tools: ToolSchema[],
    onDelta?: OnDelta,
    signal?: AbortSignal,
    forceTool?: ToolName,
  ): Promise<ChatResponse>;
  appendToolResults(results: ToolResult[]): void;
  // A user turn that is not a tool result. Distinct from one because
  // add_context mid-approval must stay a single turn.
  appendUserMessage(message: string): void;
}
