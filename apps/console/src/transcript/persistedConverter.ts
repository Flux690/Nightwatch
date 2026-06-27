import type { SessionMessage } from "@nightwatch/shared";
import type { TranscriptItem } from "./types.js";

type ProviderBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

function isProviderBlockArray(val: unknown): val is ProviderBlock[] {
  return (
    Array.isArray(val) &&
    val.every(
      (b: unknown) =>
        b !== null &&
        typeof b === "object" &&
        typeof (b as Record<string, unknown>).type === "string",
    )
  );
}

export function convertPersistedMessages(
  messages: SessionMessage[],
): TranscriptItem[] {
  // Pass 1: collect tool results by tool_use_id so tool cards can show their output.
  const toolResults = new Map<string, unknown>();
  for (const msg of messages) {
    if (msg.role !== "user" || !isProviderBlockArray(msg.providerContent)) {
      continue;
    }
    for (const block of msg.providerContent) {
      if (block.type === "tool_result") {
        toolResults.set(block.tool_use_id, block.content);
      }
    }
  }

  // Pass 2: build the ordered item list.
  const items: TranscriptItem[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (isProviderBlockArray(msg.providerContent)) {
        // Walk blocks in order: surface text as user turns, skip tool_result
        // blocks (results already collected in pass 1). A message may contain
        // both (e.g. mid-run alert injected alongside tool results).
        let textIdx = 0;
        for (const block of msg.providerContent) {
          if (block.type === "text" && block.text) {
            items.push({
              kind: "user_turn",
              id: `user-${msg.seq}-${textIdx++}`,
              text: block.text,
            });
          }
        }
      } else {
        // No providerContent: flat content string is the human-readable turn.
        if (msg.content) {
          items.push({
            kind: "user_turn",
            id: `user-${msg.seq}`,
            text: msg.content,
          });
        }
      }
    } else if (msg.role === "assistant") {
      if (isProviderBlockArray(msg.providerContent)) {
        let textIdx = 0;
        let thinkingIdx = 0;
        for (const block of msg.providerContent) {
          if (block.type === "text" && block.text) {
            items.push({
              kind: "agent_text",
              id: `agent-${msg.seq}-${textIdx++}`,
              text: block.text,
            });
          } else if (block.type === "thinking" && block.thinking) {
            items.push({
              kind: "thinking",
              id: `thinking-${msg.seq}-${thinkingIdx++}`,
              text: block.thinking,
              streaming: false,
            });
          } else if (block.type === "tool_use") {
            if (block.name === "request_clarification") {
              // Rebuild the clarification card here once answered so it survives a reload; while
              // pending the live/seeded card already covers it (see SessionView).
              if (!toolResults.has(block.id)) continue;
              const input = block.input as {
                question?: string;
                options?: Array<{ label: string; description: string }>;
                multiSelect?: boolean;
              };
              items.push({
                kind: "clarification_card",
                toolUseId: block.id,
                toolName: block.name,
                input: block.input,
                question: input.question,
                options: input.options,
                multiSelect: input.multiSelect,
                approval: "answered",
                result: toolResults.get(block.id),
              });
              continue;
            }
            items.push({
              kind: "tool_card",
              toolUseId: block.id,
              toolName: block.name,
              input: block.input,
              result: toolResults.get(block.id) ?? null,
            });
          }
        }
      } else {
        // Flat content fallback when providerContent is absent.
        if (msg.content) {
          items.push({
            kind: "agent_text",
            id: `agent-${msg.seq}`,
            text: msg.content,
          });
        }
      }
    }
  }

  return items;
}
