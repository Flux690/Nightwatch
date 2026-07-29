// The stored form of a conversation turn, ours rather than any vendor's.
// Adapters translate here only at the seed/snapshot boundary: in memory each
// keeps its native shape, which Anthropic's cache breakpoint needs stable.

export interface TextPart {
  type: "text";
  text: string;
}

// The model's reasoning. Portable as prose; the signed/encrypted original that
// some vendors require back verbatim rides in the message's `native` envelope.
export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  output: string;
  isError?: boolean;
}

export type MessagePart =
  TextPart | ReasoningPart | ToolCallPart | ToolResultPart;

// The wire shape a native message is written in, not the configured provider:
// one provider can speak several dialects whose messages are not interchangeable.
export type WireDialect =
  "anthropic-messages" | "openrouter-chat" | "openai-responses";

export interface NativeEnvelope {
  dialect: WireDialect;
  message: unknown;
}

export interface CanonicalMessage {
  role: "user" | "assistant";
  parts: MessagePart[];
  // Replayed verbatim on a same-dialect resume, since signed reasoning blocks are
  // rejected if altered. A dialect change drops it: the conversation survives a
  // provider switch, the reasoning continuity cannot.
  native?: NativeEnvelope;
}

// Human-readable rendering of a turn, for titles and list rows. Tool calls are
// named rather than dumped: the transcript projection is what renders them.
export function messagePartsToText(parts: MessagePart[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part.type === "text") out.push(part.text);
    else if (part.type === "reasoning") out.push(part.text);
    else if (part.type === "tool_call") out.push(`[tool: ${part.name}]`);
    else out.push(part.output);
  }
  return out.join("\n");
}
