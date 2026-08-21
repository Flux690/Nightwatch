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

/* Why a call did not simply answer, absent when it did. Recorded rather than
   derived from a boolean, so a file under a different name reads as a miss
   instead of in the same red as a crash. The type is derived from the list. */
export const TOOL_OUTCOMES = [
  // Some runners in a fan-out answered and some did not; the envelope names which.
  "partial",
  // The tool worked and the thing asked for is not there.
  "expected_miss",
  // Transient: a timeout, an unreachable runner, an upstream that may recover.
  "retryable",
  // Credentials or scope refused it, so widening access is the fix.
  "permission",
  // The tool itself broke.
  "system",
] as const;

export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

export function isToolOutcome(value: unknown): value is ToolOutcome {
  return typeof value === "string" && TOOL_OUTCOMES.some((o) => o === value);
}

/* What a person said when the harness stopped and asked them. Recorded at the
   call, never re-derived: the registry can say a tool needs releasing, but only
   this can say anyone was asked, and a call the harness refused was not.

   Deliberately not a member of ToolOutcome - that says how the tool behaved,
   and a human is not a tool. The same split `effect` and `policy` already make. */
export const HUMAN_DECISIONS = ["approved", "rejected", "answered"] as const;

export type HumanDecision = (typeof HUMAN_DECISIONS)[number];

export function isHumanDecision(value: unknown): value is HumanDecision {
  return typeof value === "string" && HUMAN_DECISIONS.some((d) => d === value);
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  output: string;
  // The wire fact a provider needs. Derived from `outcome` by `isToolFailure`,
  // so the two cannot disagree about whether something went wrong.
  isError?: boolean;
  // Our own classification, which no wire format carries. Stamped from what the
  // run knew, which is what lets it live with the call instead of beside it.
  outcome?: ToolOutcome;
  /* Present only when a person was actually asked. Absent is the answer for
     every call that never reached a gate - including one the harness refused
     because the tool was not offered, which used to read as an approval. */
  humanDecision?: HumanDecision;
}

/* Where the provider summarised the conversation to fit its window. Drawn,
   never replayed: the block rides in the message's `native` envelope, so
   rebuilding from parts drops it, which is what a foreign provider needs. */
export interface CompactionPart {
  type: "compaction";
}

export type MessagePart =
  TextPart | ReasoningPart | ToolCallPart | ToolResultPart | CompactionPart;

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
    else if (part.type === "tool_result") out.push(part.output);
  }
  return out.join("\n");
}
