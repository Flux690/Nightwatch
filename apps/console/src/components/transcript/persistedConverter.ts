import type {
  ApprovalRequest,
  MessagePart,
  SessionMessage,
} from "@nightwarden/shared";
import type { TranscriptItem } from "./types.js";

function clarificationFields(input: Record<string, unknown>): {
  question?: string;
  options?: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
} {
  const parsed = input as {
    question?: string;
    options?: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  };
  return {
    question: parsed.question,
    options: parsed.options,
    multiSelect: parsed.multiSelect,
  };
}

// Built from the pending row, the DB's own copy of the arguments awaiting a
// decision. `approval` stays unset: it marks a submitted decision in flight,
// which disables the buttons, not a decision still owed.
function pendingCard(pending: ApprovalRequest): TranscriptItem {
  const input = pending.toolInput;
  if (pending.kind === "clarification") {
    return {
      ...clarificationFields(input),
      kind: "clarification_card",
      toolUseId: pending.toolUseId,
      toolName: pending.toolName,
      input,
    };
  }
  if (pending.kind === "continue") {
    return { kind: "continue_card", toolUseId: pending.toolUseId };
  }
  const risk = input["risk"];
  return {
    kind: "approval_card",
    toolUseId: pending.toolUseId,
    toolName: pending.toolName,
    input,
    result: null,
    ...(typeof risk === "string" && { risk }),
  };
}

// The suspended tool call is persisted like any other, so `pending` is what turns
// the one it names into a card that asks for a decision.
export function convertPersistedMessages(
  messages: SessionMessage[],
  pending: ApprovalRequest | null = null,
): TranscriptItem[] {
  // A row with no parts renders from its flat text rather than blanking the
  // whole transcript, so one malformed message costs one turn.
  const partsOf = (msg: SessionMessage): MessagePart[] =>
    Array.isArray(msg.parts) ? msg.parts : [];

  // Pass 1: results by tool call id, so a call renders with its output.
  const toolResults = new Map<string, unknown>();
  for (const msg of messages) {
    for (const part of partsOf(msg)) {
      if (part.type === "tool_result") {
        toolResults.set(part.toolCallId, part.output);
      }
    }
  }

  // Pass 2: build the ordered item list.
  const items: TranscriptItem[] = [];

  for (const msg of messages) {
    if (msg.role === "error") {
      if (msg.content) {
        items.push({
          kind: "error_text",
          id: `error-${msg.seq}`,
          text: msg.content,
        });
      }
      continue;
    }

    // Nothing structured to walk, so the flat text is the whole turn.
    if (partsOf(msg).length === 0) {
      if (msg.content) {
        items.push({
          kind: msg.role === "user" ? "user_turn" : "agent_text",
          id: `${msg.role}-${msg.seq}`,
          text: msg.content,
        });
      }
      continue;
    }

    let idx = 0;
    for (const part of partsOf(msg)) {
      const id = `${msg.role}-${msg.seq}-${idx++}`;
      if (part.type === "text") {
        if (!part.text) continue;
        items.push(
          msg.role === "user"
            ? { kind: "user_turn", id, text: part.text }
            : { kind: "agent_text", id, text: part.text },
        );
      } else if (part.type === "reasoning") {
        if (part.text.trim()) {
          items.push({
            kind: "thinking",
            id,
            text: part.text,
            streaming: false,
          });
        }
      } else if (part.type === "tool_call") {
        if (pending?.toolUseId === part.id) {
          items.push(pendingCard(pending));
          continue;
        }
        if (part.name === "AskUserQuestion") {
          // Only the answered copy is rebuilt here; an unanswered one that is not
          // the pending row is an orphan from a run that never resumed.
          if (!toolResults.has(part.id)) continue;
          items.push({
            ...clarificationFields(part.input),
            kind: "clarification_card",
            toolUseId: part.id,
            toolName: part.name,
            input: part.input,
            approval: "answered",
            result: toolResults.get(part.id),
          });
          continue;
        }
        items.push({
          kind: "tool_card",
          toolUseId: part.id,
          toolName: part.name,
          input: part.input,
          result: toolResults.get(part.id) ?? null,
        });
      }
      // tool_result parts render inside their call, collected in pass 1.
    }
  }

  return items;
}
