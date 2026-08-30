// Provider-neutral contract. The investigation domain talks to LLMs only
// through these shapes, never to a vendor SDK directly.

import type {
  HumanDecision,
  MessagePart,
  NativeEnvelope,
  ToolName,
  ToolOutcome,
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
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  // Carried alongside the wire fields, never sent, so a result parked on the
  // session row across a suspend comes back knowing how it went.
  toolOutcome?: ToolOutcome;
  // Set only where a person was asked, which is the only place it can be known.
  humanDecision?: HumanDecision;
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
  // Current conversation in neutral form, for incremental persistence.
  snapshot(): ProviderMessage[];
  // `forceTool` is enforced by prefilling the assistant message, so the turn
  // cannot come back as prose. The report turn depends on that.
  chat(
    tools: ToolSchema[],
    onDelta?: OnDelta,
    signal?: AbortSignal,
    forceTool?: ToolName,
  ): Promise<ChatResponse>;
  appendToolResults(results: ToolResult[]): void;
  // A user turn that is not a tool result: the user's own message, or
  // anything NightWarden says to the model. Distinct from a tool_result because
  // add_context mid-approval must stay one.
  appendUserMessage(message: string): void;
}
