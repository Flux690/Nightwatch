import type { ConsoleEvent } from "@nightwarden/shared";
import { transcriptItemKey } from "@nightwarden/shared";
import type { TranscriptItem, ThinkingItem } from "./types.js";

// A non-thinking event finalizes the most recent streaming thinking burst; a later
// delta opens a fresh item rather than reopening this one. A whitespace-only burst
// is dropped so no empty "Thinking" line survives it.
function finalizeTrailingThinking(items: TranscriptItem[]): TranscriptItem[] {
  const last = items[items.length - 1];
  if (last?.kind === "thinking" && last.streaming) {
    if (!last.text.trim()) return items.slice(0, -1);
    const finalized: ThinkingItem = { ...last, streaming: false };
    return [...items.slice(0, -1), finalized];
  }
  return items;
}

// Whether the live tail is actively producing output the user can see: streamed
// reasoning with real text, streamed answer text, or an in-flight tool card. When
// false during a run, nothing is on screen yet, so the working animation shows.
export function hasActiveStream(items: TranscriptItem[]): boolean {
  const last = items[items.length - 1];
  if (!last) return false;
  if (last.kind === "thinking")
    return last.streaming && last.text.trim() !== "";
  if (last.kind === "agent_text") return true;
  if (last.kind === "tool_card") return last.state.phase === "running";
  return false;
}

export function applyLiveEvent(
  items: TranscriptItem[],
  env: ConsoleEvent,
  sessionId: string,
): TranscriptItem[] {
  if (env.type === "TEXT_MESSAGE_CONTENT") {
    const payload = env.payload;
    if (payload.sessionId !== sessionId) return items;

    if (payload.kind === "thinking") {
      const last = items[items.length - 1];
      if (last?.kind === "thinking" && last.streaming) {
        return [
          ...items.slice(0, -1),
          { ...last, text: last.text + payload.delta },
        ];
      }
      return [
        ...items,
        {
          kind: "thinking",
          id: `thinking-${Date.now()}`,
          text: payload.delta,
          streaming: true,
        },
      ];
    }

    if (payload.kind !== "text") return items;

    const settled = finalizeTrailingThinking(items);
    const last = settled[settled.length - 1];
    if (last?.kind === "agent_text") {
      return [
        ...settled.slice(0, -1),
        { ...last, text: last.text + payload.delta },
      ];
    }
    return [
      ...settled,
      { kind: "agent_text", id: `agent-${Date.now()}`, text: payload.delta },
    ];
  }

  // The API sends the finished card; the client inserts or replaces it by key
  // and never builds one itself, so a live card matches a reloaded one exactly.
  if (env.type === "TRANSCRIPT_ITEM") {
    const payload = env.payload;
    if (payload.sessionId !== sessionId) return items;
    const settled = finalizeTrailingThinking(items);
    const key = transcriptItemKey(payload.item);
    const at = settled.findIndex((item) => transcriptItemKey(item) === key);
    if (at === -1) return [...settled, payload.item];
    return settled.map((item, i) => (i === at ? payload.item : item));
  }

  return items;
}
