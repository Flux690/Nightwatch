// Provider-neutral contract. The investigation domain talks to LLMs only
// through these shapes, never to a vendor SDK directly.

import type { MessagePart, ToolName } from "@nightwarden/shared";

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

/* One value per reason a provider can report, so nothing it says is folded into
   a word meaning something else. */
export type StopReason =
  "done" | "tools" | "length" | "filtered" | "error" | "unknown";

export interface ChatResponse {
  stopReason: StopReason;
  toolUses: ToolUse[];
  text: string;
  // What the record stores for this turn, so the run never reads its own
  // history back out of the provider.
  parts: MessagePart[];
}

// A live token fragment emitted while a turn streams. `thinking` is the model's
// reasoning (Anthropic adaptive thinking); `text` is the visible answer.
export interface StreamDelta {
  kind: "text" | "thinking";
  text: string;
}

export type OnDelta = (delta: StreamDelta) => void;

// One conversation turn: `parts` is what the provider is sent and `content` its
// text rendering. The same shape a transcript row carries, minus the row.
export interface ProviderMessage {
  role: "user" | "assistant";
  content: string;
  parts: MessagePart[];
}

// Reasoning is never switched off, so the model's weakest rung is as low as a
// caller may ask for.
export interface ProviderCallOptions {
  minimalReasoning?: true;
}

/* What the investigation domain talks to. The conversation is passed in rather
   than held, so the transcript the run keeps is the only copy of it. */
export interface LLMProvider {
  // `forceTool` is the provider's own tool_choice, so the turn cannot come
  // back as prose. The report turn depends on that.
  chat(
    messages: readonly ProviderMessage[],
    tools: ToolSchema[],
    onDelta?: OnDelta,
    signal?: AbortSignal,
    forceTool?: ToolName,
  ): Promise<ChatResponse>;
}
