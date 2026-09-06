// Adapters translate only at the seed/snapshot boundary: in memory each turn
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
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  // Optional because a tool no claim may rest on is never issued one.
  evidenceId?: string;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  output: string;
  // Whether the tool failed. What it found is the output's own business: a
  // query that matched nothing answers with an empty result and no error.
  isError?: boolean;
}

// Written only where a person was asked to release a write, which is the only
// place approval can be known. A refused call never reached a gate.
export interface ToolApprovalPart {
  type: "tool_approval";
  toolCallId: string;
  approved: boolean;
  reason?: string;
}

// The answer to an elicitation. Separate from an approval because being asked
// a question and permitting a write are different acts.
export interface ElicitationAnswerPart {
  type: "elicitation_answer";
  toolCallId: string;
  text: string;
}

/* Drawn, never replayed: the block rides in the message's `native` envelope, so
   rebuilding from parts drops it, which is what a foreign provider needs. */
export interface CompactionPart {
  type: "compaction";
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | ToolApprovalPart
  | ElicitationAnswerPart
  | CompactionPart;

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
  // Replayed verbatim on a same-dialect resume, since signed reasoning blocks
  // are rejected if altered. A dialect change drops it and keeps the messages.
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
    else if (part.type === "tool_result") out.push(part.output);
    // An answer is what the person said; an approval is a decision the card draws.
    else if (part.type === "elicitation_answer") out.push(part.text);
  }
  return out.join("\n");
}
