// A turn is kept as parts alone. Whatever a provider needs handed back verbatim
// rides on the part it belongs to, under that provider's own name.

type JsonValue = null | string | number | boolean | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };

// Keyed by provider, so a part replayed into a different one carries nothing
// that provider recognises and is dropped rather than sent wrong.
export type PartProviderOptions = Record<string, JsonObject>;

export interface TextPart {
  type: "text";
  text: string;
}

// The model's reasoning. Portable as prose, and the signed or encrypted original
// some vendors require back verbatim rides in providerOptions.
export interface ReasoningPart {
  type: "reasoning";
  text: string;
  providerOptions?: PartProviderOptions;
}

export interface ToolCallPart {
  type: "tool_call";
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  output: string;
  // Carried by the answer rather than the request, because a call that has not
  // returned shows nothing anyone can cite. Absent on a tool no claim may rest on.
  evidenceId?: string;
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

/* The summary a provider wrote in place of everything above it, replayed as
   what it stands for. Drawn as a marker, so the text is kept but never shown. */
export interface CompactionPart {
  type: "compaction";
  text: string;
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | ToolApprovalPart
  | ElicitationAnswerPart
  | CompactionPart;

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
