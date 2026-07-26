import type {
  ApprovalRequest,
  Citation,
  MessagePart,
  SessionMessage,
  ToolCallState,
  TranscriptItem,
} from "@nightwarden/shared";
import { buildEvidenceIndex } from "../agent/report.js";
import { getPendingHumanInputWithSessionBySessionId } from "../db/interrupts.js";
import { getSessionMessages } from "../db/sessions.js";

const EVIDENCE_TAG_SUFFIX = /\n\n\[evidence: e\d+\]$/;
const EVIDENCE_MARKER = /\[evidence: (e\d+)\]/g;

// The tag is the model's citation handle, not something an operator should read.
function stripTag(output: string): string {
  return output.replace(EVIDENCE_TAG_SUFFIX, "");
}

// Markers the index can resolve become citations; the rest stay literal text, so
// a tag the model invented can never render as a link to nothing.
function resolveCitations(
  text: string,
  byTag: Map<string, Citation>,
): Record<string, Citation> | undefined {
  const found: Record<string, Citation> = {};
  for (const match of text.matchAll(EVIDENCE_MARKER)) {
    const tag = match[1];
    const citation = tag === undefined ? undefined : byTag.get(tag);
    if (citation) found[citation.tag] = citation;
  }
  return Object.keys(found).length > 0 ? found : undefined;
}

function cardFor(
  part: Extract<MessagePart, { type: "tool_call" }>,
  state: ToolCallState,
  pending: ApprovalRequest | null,
): TranscriptItem {
  const input = part.input;
  if (pending?.toolUseId === part.id && pending.kind === "continue") {
    return { kind: "continue_card", toolUseId: part.id, state };
  }
  if (part.name === "AskUserQuestion") {
    const parsed = input as {
      question?: string;
      options?: Array<{ label: string; description: string }>;
      multiSelect?: boolean;
    };
    return {
      kind: "clarification_card",
      toolUseId: part.id,
      toolName: part.name,
      input,
      question: parsed.question,
      options: parsed.options,
      multiSelect: parsed.multiSelect,
      state,
    };
  }
  if (pending?.toolUseId === part.id) {
    const risk = input["risk"];
    return {
      kind: "approval_card",
      toolUseId: part.id,
      toolName: part.name,
      input,
      ...(typeof risk === "string" && { risk }),
      state,
    };
  }
  return {
    kind: "tool_card",
    toolUseId: part.id,
    toolName: part.name,
    input,
    state,
  };
}

// The one place a transcript becomes something to draw. Everything the console
// needs about a tool call - its result, whether it waits on a human - is decided
// here, so the browser never reconciles sources against each other.
export function buildTranscript(sessionId: string): TranscriptItem[] {
  const messages: SessionMessage[] = getSessionMessages(sessionId);
  const pendingRow = getPendingHumanInputWithSessionBySessionId(sessionId);
  const pending: ApprovalRequest | null = pendingRow
    ? {
        sessionId: pendingRow.sessionId,
        toolName: pendingRow.toolName,
        toolInput: pendingRow.toolInput,
        toolUseId: pendingRow.toolUseId,
        kind: pendingRow.kind,
        status: "pending",
        createdAt: pendingRow.createdAt,
      }
    : null;

  const byTag = new Map<string, Citation>(
    buildEvidenceIndex(sessionId).map((entry) => [
      entry.tag,
      { tag: entry.tag, toolUseId: entry.toolUseId, toolName: entry.toolName },
    ]),
  );

  const results = new Map<string, string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool_result") {
        results.set(part.toolCallId, stripTag(part.output));
      }
    }
  }

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

    if (msg.parts.length === 0) {
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
    for (const part of msg.parts) {
      const id = `${msg.role}-${msg.seq}-${idx++}`;
      if (part.type === "text") {
        if (!part.text) continue;
        if (msg.role === "user") {
          items.push({ kind: "user_turn", id, text: part.text });
        } else {
          const citations = resolveCitations(part.text, byTag);
          items.push({
            kind: "agent_text",
            id,
            text: part.text,
            ...(citations && { citations }),
          });
        }
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
        const result = results.get(part.id);
        const state: ToolCallState =
          pending?.toolUseId === part.id
            ? { phase: "awaiting_human" }
            : result !== undefined
              ? { phase: "complete", result }
              : { phase: "running" };
        items.push(cardFor(part, state, pending));
      }
    }
  }

  return items;
}
