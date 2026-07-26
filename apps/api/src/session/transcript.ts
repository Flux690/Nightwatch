import type {
  ApprovalRequest,
  ApprovalStatus,
  Citation,
  MessagePart,
  SessionMessage,
  ToolCallState,
  TranscriptItem,
} from "@nightwarden/shared";
import { buildEvidenceIndex } from "../agent/report.js";
import { getPendingHumanInputWithSessionBySessionId } from "../db/interrupts.js";
import { getSessionMessages } from "../db/sessions.js";
import { listRemediationActionsForSession } from "../db/remediation-actions.js";

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

// The only place a tool call becomes a card. Both the transcript fetch and the
// live stream call it, which is what keeps a streamed card and a reloaded one
// byte-identical instead of merely similar.
export function toolCallCard(call: {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  state: ToolCallState;
  awaitingKind?: "approval" | "clarification" | "continue";
}): TranscriptItem {
  const { toolUseId, toolName, input, state, awaitingKind } = call;
  if (awaitingKind === "continue") {
    return { kind: "continue_card", toolUseId, state };
  }
  if (toolName === "AskUserQuestion") {
    const parsed = input as {
      question?: string;
      options?: Array<{ label: string; description: string }>;
      multiSelect?: boolean;
    };
    return {
      kind: "clarification_card",
      toolUseId,
      toolName,
      input,
      question: parsed.question,
      options: parsed.options,
      multiSelect: parsed.multiSelect,
      state,
    };
  }
  if (awaitingKind === "approval") {
    const risk = input["risk"];
    return {
      kind: "approval_card",
      toolUseId,
      toolName,
      input,
      ...(typeof risk === "string" && { risk }),
      state,
    };
  }
  return { kind: "tool_card", toolUseId, toolName, input, state };
}

// The evidence tag is the model's citation handle, never operator-facing text.
export function stripEvidenceTag(output: string): string {
  return output.replace(EVIDENCE_TAG_SUFFIX, "");
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

  // A decision the operator already made. Without this a reloaded transcript
  // shows the tool's output but forgets who released it.
  const decisions = new Map<
    string,
    { decision: ApprovalStatus; by?: string }
  >();
  for (const action of listRemediationActionsForSession(sessionId)) {
    decisions.set(action.toolUseId, {
      decision: action.status === "rejected" ? "rejected" : "approved",
      ...(action.resolvedBy && { by: action.resolvedBy }),
    });
  }

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
        const decided = decisions.get(part.id);
        const answered =
          part.name === "AskUserQuestion" && result !== undefined;
        const state: ToolCallState =
          pending?.toolUseId === part.id
            ? { phase: "awaiting_human" }
            : decided
              ? {
                  phase: "resolved",
                  ...decided,
                  ...(result !== undefined && { result }),
                }
              : answered
                ? { phase: "resolved", decision: "answered", result }
                : result !== undefined
                  ? { phase: "complete", result }
                  : { phase: "running" };
        items.push(
          toolCallCard({
            toolUseId: part.id,
            toolName: part.name,
            input: part.input,
            state,
            // A decided call stays an approval card so its outcome has somewhere
            // to render, not just the tool output it produced.
            ...((pending?.toolUseId === part.id && pending.kind) || decided
              ? { awaitingKind: pending?.kind ?? "approval" }
              : {}),
          }),
        );
      }
    }
  }

  return items;
}
